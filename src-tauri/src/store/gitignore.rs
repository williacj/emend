// ABOUTME: Shared `.emend/.gitignore` maintenance (TD-12) for every machine-local runtime
// ABOUTME: sidecar — appends an exclusion pattern once, never touches or reorders existing entries.

//! TD-12: TD-4 commits all of `.emend/` by default, but per-machine runtime state is meaningless
//! off-machine and must never travel through checkpoint commits or review sync. The recorded
//! exclusion mechanism is a **committed** `.emend/.gitignore` that each runtime sidecar's own
//! module maintains on first write; this module is the one shared implementation, so a caller never
//! reimplements the same idempotent append.
//!
//! **The excluded list is exactly `tab-session.json`, and `store::tab_session` is the one
//! production caller** (TD-12 amended, 2026-08-14). TD-20 moved the ownership registry — formerly
//! `.emend/lock*`, this module's other caller — out of the project folder entirely and into
//! per-user app-local data, where nothing needs excluding because nothing is committed. TD-12's
//! standing rule is unchanged and now covers the whole list: **every future addition names its own
//! file in its own decision-log line**, so a new caller is a recorded decision, never a quiet
//! second `ensure_pattern` call.

use std::fs;
use std::io;
use std::path::Path;

/// Ensures `emend_dir`'s `.gitignore` contains `pattern` on its own line, preceded by `comment`
/// the first time it's added. Idempotent and non-destructive: appends nothing — and does not
/// rewrite the file at all — once `pattern` is already present; existing entries (including ones
/// this function didn't write) are always preserved. `emend_dir` is the project's `.emend/`
/// directory itself (not the project root), and is created if missing.
pub fn ensure_pattern(emend_dir: &Path, pattern: &str, comment: &str) -> io::Result<()> {
    fs::create_dir_all(emend_dir)?;
    let path = emend_dir.join(".gitignore");
    let existing = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e),
    };
    if existing.lines().any(|line| line.trim() == pattern) {
        return Ok(());
    }
    let mut updated = existing;
    if !updated.is_empty() && !updated.ends_with('\n') {
        updated.push('\n');
    }
    updated.push_str(comment);
    updated.push('\n');
    updated.push_str(pattern);
    updated.push('\n');
    fs::write(&path, updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// TD-12's excluded list, and the sample this module's own behavior tests append — the one
    /// pattern a production caller actually passes.
    const SESSION_PATTERN: &str = "tab-session.json";

    #[test]
    fn adds_the_pattern_and_comment_to_a_fresh_gitignore() {
        let dir = TempDir::new().unwrap();
        let emend_dir = dir.path().join(".emend");

        ensure_pattern(&emend_dir, SESSION_PATTERN, "# comment").unwrap();

        let content = fs::read_to_string(emend_dir.join(".gitignore")).unwrap();
        assert!(content.lines().any(|l| l == "# comment"));
        assert!(content.lines().any(|l| l == SESSION_PATTERN));
    }

    #[test]
    fn preserves_existing_entries_when_appending() {
        let dir = TempDir::new().unwrap();
        let emend_dir = dir.path().join(".emend");
        fs::create_dir_all(&emend_dir).unwrap();
        fs::write(emend_dir.join(".gitignore"), "custom-entry\n").unwrap();

        ensure_pattern(&emend_dir, SESSION_PATTERN, "# comment").unwrap();

        let content = fs::read_to_string(emend_dir.join(".gitignore")).unwrap();
        assert!(content.lines().any(|l| l == "custom-entry"));
        assert!(content.lines().any(|l| l == SESSION_PATTERN));
    }

    #[test]
    fn is_byte_identical_when_the_pattern_is_already_present() {
        let dir = TempDir::new().unwrap();
        let emend_dir = dir.path().join(".emend");
        fs::create_dir_all(&emend_dir).unwrap();
        let existing = format!("custom-entry\n{SESSION_PATTERN}\n");
        fs::write(emend_dir.join(".gitignore"), &existing).unwrap();

        ensure_pattern(&emend_dir, SESSION_PATTERN, "# comment").unwrap();

        assert_eq!(
            fs::read_to_string(emend_dir.join(".gitignore")).unwrap(),
            existing
        );
    }

    #[test]
    fn distinct_patterns_from_distinct_callers_coexist() {
        let dir = TempDir::new().unwrap();
        let emend_dir = dir.path().join(".emend");

        ensure_pattern(&emend_dir, SESSION_PATTERN, "# tab session").unwrap();
        ensure_pattern(
            &emend_dir,
            "some-future-sidecar.json",
            "# a future addition",
        )
        .unwrap();

        let content = fs::read_to_string(emend_dir.join(".gitignore")).unwrap();
        assert!(content.lines().any(|l| l == SESSION_PATTERN));
        assert!(content.lines().any(|l| l == "some-future-sidecar.json"));
    }

    #[test]
    fn creates_the_cowrite_dir_if_it_does_not_exist_yet() {
        let dir = TempDir::new().unwrap();
        let emend_dir = dir.path().join(".emend");
        assert!(!emend_dir.exists());

        ensure_pattern(&emend_dir, SESSION_PATTERN, "# comment").unwrap();

        assert!(emend_dir.join(".gitignore").exists());
    }
}

/// TD-12 amended (2026-08-14): the excluded list is exactly `tab-session.json`, so exactly one
/// module may reach [`ensure_pattern`], and the relocated ownership registry's pattern must survive
/// nowhere. Both are properties of the *source tree*, not of any one call, so both are checked by
/// reading it (card #1746 criterion 6). A source scan is the weaker of the two available
/// mechanisms — module privacy would enforce the caller set by construction — but TD-12's amendment
/// and this card both keep `store::gitignore` a `store::` sibling, so privacy is not available
/// without contradicting them.
#[cfg(test)]
mod caller_set_tests {
    use crate::test_support;

    /// This module's own file, which necessarily names anything the scan looks for.
    const SELF: &str = "src/store/gitignore.rs";

    /// Shipped backend sources containing `needle`, excluding this module's own file.
    fn shipped_sources_naming(needle: &str) -> Vec<String> {
        test_support::shipped_sources_naming(needle, SELF)
    }

    #[test]
    fn ensure_pattern_has_exactly_one_production_caller() {
        // The bare identifier, not a `gitignore::`-qualified call: a caller that does
        // `use crate::store::gitignore::ensure_pattern;` and then calls it unqualified adds exactly
        // the caller this pins, and a qualified-call needle would not see it.
        let callers = shipped_sources_naming("ensure_pattern");

        // A positive allowlist. Naming the one sanctioned caller fails on *any* new one, where a
        // denylist of the callers this card removed would pass for every caller added next.
        assert_eq!(callers, vec!["src/store/tab_session.rs".to_string()]);
    }

    #[test]
    fn no_shipped_source_still_writes_the_relocated_registrys_gitignore_pattern() {
        // Assembled rather than written out, so this assertion is not itself an occurrence.
        let survivors = shipped_sources_naming(&format!("\"lock{}\"", '*'));

        assert!(
            survivors.is_empty(),
            "the relocated registry's `.emend/.gitignore` pattern survives in {survivors:?}"
        );
    }
}
