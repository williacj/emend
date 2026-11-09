// ABOUTME: The one project-identity rule (TD-20 ruling (3)) — canonical root, blake3 project key,
// ABOUTME: plus `project_dir`, the `<app_local_data_dir>/<area>/<key>/` layout all four of them use.

//! Every per-project store that lives *outside* the project — the D15/P2a-17 transcript log, the
//! adoption log, TD-20's ownership registry, and the FR-ED-3 tab-session writer lease — names its
//! per-project artifact by "blake3 of the canonical root", and all four resolve one directory,
//! `<area>/<key>/`, through [`project_dir`] (#2245). The key is the one rule and the layout around
//! it is the same rule: what a store chooses for itself is only the leaf name *inside* its own
//! per-project directory. TD-20 ruling (3) states the key as **one** rule ("the
//! identical keying `store::transcript` already uses"), and D15/P2a-17 depend on it: a reader
//! holding an opaque key under `app_local_data_dir` can only conclude "one key means one project"
//! if every store derives it the same way. This module is that rule, so the stores agree by
//! construction rather than by each module hashing its own bytes (#2231).
//!
//! # The bytes the key hashes
//!
//! A path is not a string, so "hash the canonical root" has to say *which bytes*. Two spellings
//! were both in the tree before this module, and both are wrong for a key that names a directory
//! on disk:
//!
//! - `to_string_lossy().as_bytes()` is **not injective**. Anything a path cannot express as
//!   Unicode collapses to `U+FFFD`, so two genuinely distinct roots hash to one key — and two
//!   projects would then share one transcript store. Silent collision of user data is the worst
//!   failure available here.
//! - `as_os_str().as_encoded_bytes()` is injective but **not durable**. `std` documents its
//!   encoding as "an unspecified, platform-specific, self-synchronizing superset of UTF-8" whose
//!   non-UTF-8 sub-slices are "only comparable within the same Rust version built for the same
//!   target platform", and says outright that "storing it in a file will likely result in
//!   incompatible byte slices". A key *is* stored on disk and must still match after a toolchain
//!   upgrade — the same argument [`project_key`] already records for choosing blake3 over `std`'s
//!   version-dependent `DefaultHasher`.
//!
//! So the encoding is stated here rather than borrowed. A root that is valid Unicode — every root
//! either shipped platform can realistically produce, since APFS/HFS+ reject invalid UTF-8 outright
//! and Win32 never mints an unpaired surrogate — hashes its **UTF-8 bytes**, which is
//! byte-identical to what both older spellings produced, so no existing on-disk store moves. A root
//! that is not valid Unicode hashes a tagged, lossless, per-platform-*documented* encoding
//! ([`key_bytes`]): injective, and specified by us rather than by an `std` implementation detail.
//!
//! The encodings differ across platforms only for that non-Unicode case, which is sound because
//! these stores are machine-local by decision (D15: "conversation history is local to the machine
//! per-project") — a key is never compared across two machines, and a path's very representation
//! differs across the platforms anyway.

use std::borrow::Cow;
use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};

/// `root` canonicalized, or the error explaining why it could not be. The **fallible** half of the
/// rule, for a caller that must refuse a root it cannot resolve: TD-20 ruling (4) requires a root
/// that cannot be canonicalized to fail *before* the ownership registry is touched, so a vanished
/// project never creates state, and `commands::tabs` likewise refuses to lease a session for a
/// folder that is not there.
pub fn require_canonical_root(root: &Path) -> io::Result<PathBuf> {
    root.canonicalize()
}

/// `root` in the spelling [`project_key`] hashes over: canonicalized, falling back to the path as
/// given when it cannot be canonicalized (not yet created, or already gone).
///
/// **The fallback is deliberate here and wrong for a routing decision.** Machine-local per-project
/// state keyed off a vanished root is harmless — a directory nobody will read again — so the stores
/// keep working rather than erroring on a path that has just been deleted. A caller that needs the
/// refusal calls [`require_canonical_root`] instead; both route through the one canonicalization
/// call, so the two dispositions of one rule cannot drift apart.
///
/// Load-bearing for project *identity*, not just tidiness: `agent::project::is_root` and
/// `commands::project`'s already-open check compare paths, and on Windows two spellings of one
/// directory that differ only in case compare unequal as raw `PathBuf`s. Without this, reopening
/// the project you already have open reads as a project *change* — which tears down a live MCP
/// server out from under a running agent (PR #513 review 2026-07-21, Important).
pub fn canonical_root(root: &Path) -> PathBuf {
    require_canonical_root(root).unwrap_or_else(|_| root.to_path_buf())
}

/// A stable, deterministic directory key for `root` (a project's path), so a store that lives
/// *outside* the project entirely (D15: never under `.cowrite/`, never repo-synced) still keys one
/// store per project. blake3 (already used for `textops::Revision`'s content hashes, tech-design
/// decision log 2026-07-10) rather than `std`'s `DefaultHasher`: the latter's algorithm is an
/// unspecified, version-dependent implementation detail, which would risk silently orphaning every
/// existing on-disk store across a Rust toolchain upgrade. Two spellings of one directory key to
/// one store ([`canonical_root`]); two genuinely distinct roots never collide ([`key_bytes`]).
///
/// **Private on purpose (#2245 review).** The bare key is the ingredient of a per-project path, and
/// a store that holds it can join it onto a path of its own — which is exactly the divergence this
/// module exists to prevent. Production code therefore reaches the key only *through*
/// [`project_dir`], enforced by visibility rather than by a source scan: a scan pins a spelling, and
/// a glob import, a module alias, or a braced import list walks straight past every spelling it pins.
/// A sibling store's own layout test names the key through
/// [`project_key_for_layout_tests`] instead.
fn project_key(root: &Path) -> String {
    blake3::hash(&key_bytes(canonical_root(root).as_os_str()))
        .to_hex()
        .to_string()
}

/// [`project_key`] for a sibling store's own layout test, which has to name the key component it
/// expects to find in the path its store resolved. `#[cfg(test)]`, so it does not exist in a
/// production build at all and no shipped path can reach the key through it.
#[cfg(test)]
pub(crate) fn project_key_for_layout_tests(root: &Path) -> String {
    project_key(root)
}

/// `<app_local_data_dir>/<area>/<project_key(root)>/` — the per-project directory an
/// app-local-data store resolves for `root`, with `area` naming the store (`transcripts`,
/// `adoptions`, `instances`, `tab-session-writers`). The single authority for where a project's
/// app-local state lives: every such store composes its path here rather than joining the key
/// itself (#2245). Pure: resolving a path creates nothing.
pub fn project_dir(app_local_data_dir: &Path, area: &str, root: &Path) -> PathBuf {
    app_local_data_dir.join(area).join(project_key(root))
}

/// Distinguishes the escaped encoding below from a path's own UTF-8 bytes. A NUL byte terminates a
/// string in both platforms' path APIs and so cannot occur inside any real path, which is what
/// makes a leading one a tag the UTF-8 branch can never accidentally produce.
const NON_UNICODE_TAG: u8 = 0;

/// The exact bytes [`project_key`] hashes for an already-canonical `root` — injective, and
/// specified here rather than deferred to `std` (see the module docs for why both borrowings are
/// unsuitable). Returned as bytes rather than folded into the hasher so the encoding stays one
/// readable expression: it is an on-disk contract, and the next reader has to be able to see it.
fn key_bytes(root: &OsStr) -> Cow<'_, [u8]> {
    match root.to_str() {
        // The overwhelmingly normal case, and every case either shipped platform realistically
        // produces: the path's UTF-8 bytes, exactly what both pre-#2231 spellings hashed. Borrowed,
        // so the common path costs no allocation — this runs on every store path resolution.
        Some(text) => Cow::Borrowed(text.as_bytes()),
        None => Cow::Owned(
            std::iter::once(NON_UNICODE_TAG)
                .chain(non_unicode_bytes(root))
                .collect(),
        ),
    }
}

/// A path that is not valid Unicode, in this platform's own documented representation.
///
/// Windows: the OS's UTF-16 code units (`OsStrExt::encode_wide` — a specified API, unlike an
/// unspecified byte encoding), emitted big-endian so the key cannot vary with host endianness.
#[cfg(windows)]
fn non_unicode_bytes(root: &OsStr) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    root.encode_wide().flat_map(u16::to_be_bytes).collect()
}

/// Unix: the raw bytes, which is what a path *is* on this platform
/// (`std::os::unix::ffi::OsStrExt::as_bytes`, a specified API).
#[cfg(unix)]
fn non_unicode_bytes(root: &OsStr) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    root.as_bytes().to_vec()
}

/// Two roots that are not valid Unicode and differ **only** outside Unicode — the one input class
/// on which the pre-#2231 spellings of "blake3(canonical root)" disagree with each other, and on
/// which `to_string_lossy()` maps both of these distinct paths to the same string. Platform-shaped
/// because a path's representation is. Neither exists on disk, so `canonical_root` yields each
/// unchanged and no directory has to be created to reach the case.
#[cfg(test)]
fn non_unicode_roots() -> (PathBuf, PathBuf) {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;
        // `C:\` then a lone high surrogate: well-formed UTF-16 requires it to be paired, so
        // `to_str()` is `None` and `to_string_lossy()` replaces it with U+FFFD.
        let of =
            |unit: u16| PathBuf::from(OsString::from_wide(&[0x0043, 0x003A, 0x005C, unit][..]));
        (of(0xD800), of(0xD801))
    }
    #[cfg(unix)]
    {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;
        let of = |byte: u8| PathBuf::from(OsString::from_vec(vec![b'/', byte]));
        (of(0xFE), of(0xFF))
    }
}

#[cfg(test)]
mod key_rule_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn the_same_project_root_always_yields_the_same_key() {
        let dir = TempDir::new().unwrap();
        assert_eq!(project_key(dir.path()), project_key(dir.path()));
    }

    #[test]
    fn distinct_project_roots_yield_distinct_keys() {
        let a = TempDir::new().unwrap();
        let b = TempDir::new().unwrap();
        assert_ne!(project_key(a.path()), project_key(b.path()));
    }

    #[test]
    fn a_root_that_does_not_exist_still_yields_a_deterministic_key_not_a_panic() {
        let missing = Path::new("/does/not/exist/on/this/machine");
        assert_eq!(project_key(missing), project_key(missing));
    }

    #[test]
    fn a_root_that_cannot_be_canonicalized_is_a_refusal_for_a_caller_that_needs_one() {
        let missing = Path::new("/does/not/exist/on/this/machine");

        // The same input the fallback rule tolerates, so the pair genuinely differs in disposition
        // rather than in what it is handed.
        assert!(require_canonical_root(missing).is_err());
        assert_eq!(canonical_root(missing), missing.to_path_buf());
    }

    #[test]
    fn project_dir_is_the_area_then_the_key() {
        let app_data = Path::new("/app-local-data");
        let dir = TempDir::new().unwrap();

        assert_eq!(
            project_dir(app_data, "transcripts", dir.path()),
            app_data.join("transcripts").join(project_key(dir.path()))
        );
    }
}

#[cfg(test)]
mod key_encoding_tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn two_roots_that_differ_only_outside_unicode_never_share_a_key() {
        let (a, b) = super::non_unicode_roots();

        // The precondition: the rule this replaced saw one path here, which is what makes asserting
        // the keys differ a real assertion rather than a restatement of `a != b`.
        assert_ne!(a, b);
        assert_eq!(a.to_string_lossy(), b.to_string_lossy());

        assert_ne!(project_key(&a), project_key(&b));
    }

    #[test]
    fn a_valid_unicode_root_keys_exactly_where_it_already_did() {
        // A fixed literal rather than a temp dir, so this pins the bytes rather than whatever path
        // the OS hands back today. `canonicalize` fails on it, so `canonical_root` yields it as-is.
        let root = PathBuf::from("/projects/my-book");
        assert!(
            root.to_str().is_some(),
            "the no-migration case is a Unicode root"
        );

        // Both pre-#2231 spellings, re-derived here on purpose: this is the one assertion that must
        // *not* route through the shared rule, or it could not detect the shared rule moving.
        let lossy = blake3::hash(root.to_string_lossy().as_bytes())
            .to_hex()
            .to_string();
        let encoded = blake3::hash(root.as_os_str().as_encoded_bytes())
            .to_hex()
            .to_string();

        assert_eq!(project_key(&root), lossy);
        assert_eq!(project_key(&root), encoded);
    }

    #[test]
    fn a_projects_key_is_a_fixed_value_a_toolchain_upgrade_cannot_move() {
        let root = Path::new("/projects/my-book");
        // The digest below is of the path's own bytes, which only holds while `canonicalize` has
        // nothing to resolve. Said out loud so a machine that happens to have this directory gets
        // this sentence rather than a bare digest mismatch.
        assert!(
            !root.exists(),
            "this golden pins the un-canonicalized spelling, so {root:?} must not exist here"
        );

        // A golden digest — verified independently as `blake3(b\"/projects/my-book\")`, not read
        // back out of this implementation. Any change to the hash, to the bytes hashed, or to the
        // canonicalization fallback orphans every on-disk store for this root and reddens here.
        assert_eq!(
            project_key(root),
            "043ab8e3e0f41dea16228b4c0bd09dd5e59401b70ca4e025958e2b262baba20d"
        );
    }
}

#[cfg(test)]
mod one_rule_tests {
    use super::project_key;
    use crate::commands::tabs;
    use crate::store::{adoption, lock, transcript};
    use std::path::{Path, PathBuf};

    /// The per-project *directory* each store resolves for `root`, read off the path the store
    /// itself returns — never re-derived here, or every entry would agree by construction whatever
    /// the stores did. Three stores name a file inside that directory; TD-20's ownership registry
    /// names the directory itself.
    fn dirs_the_stores_actually_use(app_data: &Path, root: &Path) -> Vec<(&'static str, PathBuf)> {
        let containing = |path: PathBuf| path.parent().unwrap().to_path_buf();
        vec![
            (
                "transcript",
                containing(transcript::transcript_file(app_data, root)),
            ),
            (
                "adoption",
                containing(adoption::adoption_file(app_data, root)),
            ),
            ("ownership registry", lock::registry_dir(app_data, root)),
            (
                "tab-session lease",
                containing(tabs::lease_path(app_data, root)),
            ),
        ]
    }

    /// The key component of each store's per-project directory.
    fn keys_the_stores_actually_use(app_data: &Path, root: &Path) -> Vec<(&'static str, String)> {
        dirs_the_stores_actually_use(app_data, root)
            .into_iter()
            .map(|(store, dir)| {
                (
                    store,
                    dir.file_name().unwrap().to_string_lossy().into_owned(),
                )
            })
            .collect()
    }

    /// One rule must produce one *shape*, not just one key: every store's per-project directory is
    /// `<app_local_data_dir>/<one area component>/<key>`, so `project_dir` is the single authority
    /// for where a project's app-local state lives (#2245). **Axis:** varies over the four stores
    /// and over each one's layout; it holds fixed the app-local-data root and the leaf filename a
    /// store chooses *inside* its directory, neither of which this rule governs. A fifth store
    /// added to `dirs_the_stores_actually_use` reddens the count assertion below, so it cannot be
    /// compared silently; one added to the crate and *not* to that helper is invisible **here** —
    /// but it cannot get the shape wrong either, because `project_key` is private and
    /// [`super::project_dir`] is the only way it can reach a per-project directory at all.
    #[test]
    fn every_per_project_store_lays_its_key_out_as_one_area_then_the_key() {
        let app_data = Path::new("/app-local-data");
        let root = Path::new("/projects/my-book");
        let key = project_key(root);

        let dirs = dirs_the_stores_actually_use(app_data, root);

        assert_eq!(dirs.len(), 4, "every app-local-data store must be compared");
        for (store, dir) in &dirs {
            let below: Vec<String> = dir
                .strip_prefix(app_data)
                .unwrap_or_else(|_| panic!("{store} resolved {dir:?} outside {app_data:?}"))
                .iter()
                .map(|part| part.to_string_lossy().into_owned())
                .collect();

            assert_eq!(
                below.len(),
                2,
                "{store} must name one area directory then the shared key, got {below:?}"
            );
            assert_eq!(
                below[1], key,
                "{store} must end at the shared key, which is what `project_dir` puts there"
            );
        }
    }

    #[test]
    fn every_per_project_store_keys_one_root_the_same_way() {
        let app_data = Path::new("/app-local-data");
        // A root whose `to_string_lossy()` and `as_os_str().as_encoded_bytes()` forms differ, which
        // is the only input on which two spellings of "blake3(canonical root)" can disagree.
        // Asserting each store's key on an ordinary root would have passed before #2231.
        let (root, _) = super::non_unicode_roots();

        let keys = keys_the_stores_actually_use(app_data, &root);

        assert_eq!(keys.len(), 4, "every app-local-data store must be compared");
        let distinct: std::collections::BTreeSet<&str> =
            keys.iter().map(|(_, key)| key.as_str()).collect();
        assert_eq!(
            distinct.len(),
            1,
            "one project root must key one directory in every store, got {keys:?}"
        );
    }

    #[test]
    fn an_ordinary_unicode_root_also_keys_one_directory_in_every_store() {
        let app_data = Path::new("/app-local-data");
        let root = Path::new("/projects/my-book");

        let keys = keys_the_stores_actually_use(app_data, root);

        let distinct: std::collections::BTreeSet<&str> =
            keys.iter().map(|(_, key)| key.as_str()).collect();
        assert_eq!(distinct.len(), 1, "got {keys:?}");
    }
}

/// Source-text pins that the rule above is the *only* one. The behavioural tests compare the four
/// stores that exist today; these fail on a fifth store, or on any module that starts hashing its
/// own bytes again — the `store::gitignore::caller_set_tests` style, positive allowlists rather
/// than denylists of what this card removed.
#[cfg(test)]
mod caller_set_tests {
    use crate::test_support;

    /// This module's own file, which necessarily names anything the scan looks for.
    const SELF: &str = "src/store/project_identity.rs";

    /// Shipped backend sources containing `needle`, excluding this module's own file.
    fn shipped_sources_naming(needle: &str) -> Vec<String> {
        test_support::shipped_sources_naming(needle, SELF)
    }

    #[test]
    fn only_sanctioned_sources_hash_their_own_bytes() {
        // The crate path, not `blake3::hash` specifically: the needle has to vary over *how* a
        // module could hash as well as over which module does, or `blake3::Hasher::new()` would
        // walk straight past it. Prose mentions of the algorithm carry no `::` and are unaffected.
        let hashers = shipped_sources_naming("blake3::");

        // A positive allowlist over the whole backend crate. Naming the sanctioned hashers fails on
        // any new one — including a fifth per-project store deriving its own key — where a denylist
        // of the two call sites #2231 removed would pass for every one added next. These are not
        // project keys: tabs hashes serialized session JSON for CAS, textops hashes document text
        // (tech-design decision log 2026-07-10), permission_adapter hashes script contents for
        // CJ's run-local unchanged-script grant (D14/J7, 2026-09-07, #2399), and the voice model
        // registry, downloader, and inference adapter validate local model bytes against trusted
        // expected digests (FR-ED-5). Inference rechecks the exact bytes passed to whisper.cpp.
        // Settings and transcription tests mint only their own fake fixture digests.
        assert_eq!(
            hashers,
            vec![
                "crates/textops/src/revision.rs".to_string(),
                "src/agent/permission_adapter.rs".to_string(),
                "src/commands/tabs.rs".to_string(),
                "src/voice/model_download.rs".to_string(),
                "src/voice/model_registry.rs".to_string(),
                "src/voice/settings.rs".to_string(),
                "src/voice/transcription.rs".to_string(),
                "src/voice/transcription/whisper_backend.rs".to_string(),
            ]
        );
    }

    /// The layout half of the same claim (#2245): a store may resolve a per-project *directory*,
    /// but composing one is [`super::project_dir`]'s alone.
    ///
    /// **That claim is not this test's to make, and the first draft of this test made it anyway**
    /// (#2245 review, Important). It scanned for the string `project_identity::project_key` and
    /// called that "composed by project_dir" — but `use super::project_identity::*;` reaches the
    /// same function while containing no such string. So does a module alias, and so does a braced
    /// import list — `use crate::store::project_identity::{project_key};`, which is the very idiom
    /// `store::lock` already uses one line down for `project_dir`. (A *renamed* import through the
    /// full path, `::project_key as pk`, is the one escape the old needle did catch; measured, not
    /// assumed.) A guard that names an axis it does not enforce is the same shape as the
    /// guard this card replaced, so the claim moved to a mechanism that can carry it:
    /// [`super::project_key`] is **private**, so no shipped path can reach the bare key by any
    /// spelling, and `only_sanctioned_sources_hash_their_own_bytes` above stops a store computing
    /// its own. Those two together are what enforce it; the compiler needs no help from a scan.
    ///
    /// **What is left for a scan, and is all this asserts:** which `#[cfg(test)]` modules re-derive
    /// the key through the test-only accessor. **Axis:** varies over every shipped file. It is
    /// blind to a *new* use added inside either allowlisted file, and it says nothing about
    /// production reach, which is the compiler's to refuse and not this test's to detect.
    #[test]
    fn only_sanctioned_test_modules_re_derive_the_key() {
        let namers = shipped_sources_naming("project_key_for_layout_tests");

        assert_eq!(
            namers,
            vec![
                "src/store/lock.rs".to_string(),
                "src/store/transcript.rs".to_string(),
            ],
            "only a sibling store's own layout test may re-derive the key"
        );
    }

    #[test]
    fn the_canonical_root_rule_has_exactly_one_implementation() {
        // The `fn` *definitions*, not the calls: a module that calls the shared rule is the point,
        // and one that redefines it is the defect. `agent::project` re-exposes the rule under the
        // name its own callers already use and is documented as delegating here.
        let definitions = shipped_sources_naming("fn canonical_root(");

        assert_eq!(definitions, vec!["src/agent/project.rs".to_string()]);
    }

    #[test]
    fn no_shipped_source_still_hashes_a_paths_lossy_or_encoded_bytes() {
        // Assembled rather than written out, so these assertions are not themselves occurrences.
        let lossy = shipped_sources_naming(&format!("to_string_lossy().as{}", "_bytes()"));
        let encoded = shipped_sources_naming(&format!("as_os_str().as{}", "_encoded_bytes()"));

        assert!(
            lossy.is_empty(),
            "the lossy key spelling survives in {lossy:?}"
        );
        assert!(
            encoded.is_empty(),
            "the encoded key spelling survives in {encoded:?}"
        );
    }
}
