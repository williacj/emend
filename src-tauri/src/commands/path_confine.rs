// ABOUTME: Path confinement (§3.5) — every IPC path is canonicalized against its project root and
// ABOUTME: confined to it; empty/null-byte/absolute/`..`/symlink-escape requests are all rejected.

use std::fmt;
use std::path::{Component, Path, PathBuf};

/// Why a requested path was refused. Each variant names one §3.5 rejection rule.
#[derive(Debug, PartialEq, Eq)]
pub enum ConfineError {
    Empty,
    NullByte,
    Absolute,
    ParentTraversal,
    Escapes,
    Io(String),
}

impl fmt::Display for ConfineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ConfineError::Empty => write!(f, "path confinement: empty path"),
            ConfineError::NullByte => write!(f, "path confinement: null byte in path"),
            ConfineError::Absolute => write!(f, "path confinement: absolute path not allowed"),
            ConfineError::ParentTraversal => {
                write!(f, "path confinement: `..` traversal not allowed")
            }
            ConfineError::Escapes => write!(f, "path confinement: path escapes the project root"),
            ConfineError::Io(e) => write!(f, "path confinement: {e}"),
        }
    }
}

impl std::error::Error for ConfineError {}

/// Confines `requested` (a project-relative path) to `root`.
///
/// Rejects null bytes, absolute paths, and `..` components outright (lexical, no I/O). Then
/// canonicalizes `root` and the deepest *existing* ancestor of the joined candidate, and requires
/// that resolved ancestor to still live under the resolved root — this is what catches a
/// symlinked intermediate directory smuggling the path outside `root` even though the leaf itself
/// may not exist yet (e.g. a not-yet-created save target). §3.5: "every repo-relative IPC/tool
/// path canonicalized and confined; null-byte/symlink/`..` rejected."
pub fn confine(root: &Path, requested: &str) -> Result<PathBuf, ConfineError> {
    if requested.is_empty() {
        return Err(ConfineError::Empty);
    }
    if requested.contains('\0') {
        return Err(ConfineError::NullByte);
    }

    let requested_path = Path::new(requested);
    if requested_path.is_absolute() {
        return Err(ConfineError::Absolute);
    }
    if requested_path
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(ConfineError::ParentTraversal);
    }

    let root_canonical = root
        .canonicalize()
        .map_err(|e| ConfineError::Io(e.to_string()))?;
    let candidate = root_canonical.join(requested_path);

    let resolved_ancestor = deepest_existing_ancestor(&candidate)
        .canonicalize()
        .map_err(|e| ConfineError::Io(e.to_string()))?;
    if !resolved_ancestor.starts_with(&root_canonical) {
        return Err(ConfineError::Escapes);
    }

    Ok(candidate)
}

/// The one spelling of a project-relative path the app keys on: forward-slash separated, with `.`
/// segments and platform separators normalized away.
///
/// [`confine`] is deliberately lenient about spelling — `notes/outline.md`, `./notes/outline.md`
/// and (on Windows) `notes\outline.md` all resolve to the same file. That is right for *reading*,
/// but any surface that hands a path back out — to the frontend, or into a map keyed by path —
/// must emit a single canonical form, or the same document silently fails to match itself.
///
/// Lexical and I/O-free: this is the tail of what `confine(root, requested)` already produced
/// (`root_canonical.join(requested)`), recovered without re-canonicalizing the root. Non-`Normal`
/// components are dropped defensively; `confine` has already rejected the absolute and `..` ones.
pub fn canonical_relative(requested: &str) -> String {
    Path::new(requested)
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

/// The one project-relative key a document's sidecar identity is minted and looked up under: an
/// already-[`confine`]d path resolved to the file's *own* on-disk spelling, made relative to the
/// resolved root, forward-slash separated.
///
/// [`canonical_relative`] normalizes what the caller *wrote*; this normalizes what the filesystem
/// *holds* — on a case-insensitive volume `Notes/Outline.md` and `notes/outline.md` are one file,
/// and two surfaces keying `docs.json` on their own spelling would mint (or miss) two identities
/// for it (PR #502 review). Shared so the surfaces that must agree — `agent::state`'s tool paths,
/// which mint the identity, and `commands::changes`'s parse join, which looks it up — cannot drift
/// into two notions of the same document. When the leaf (or more of its tail) does not exist, the
/// deepest existing ancestor is resolved to the filesystem's spelling before the missing tail is
/// appended. That preserves the same identity through Missing-on-disk Save As even when an
/// ancestor was supplied through a symlink or case-only alias.
pub fn identity_relative(root: &Path, confined: &Path) -> Result<String, ConfineError> {
    let root_canonical = root
        .canonicalize()
        .map_err(|e| ConfineError::Io(e.to_string()))?;
    let existing_ancestor = deepest_existing_ancestor(confined);
    let missing_tail = confined
        .strip_prefix(&existing_ancestor)
        .map_err(|e| ConfineError::Io(e.to_string()))?;
    let resolved_ancestor = existing_ancestor
        .canonicalize()
        .map_err(|e| ConfineError::Io(e.to_string()))?;
    // `confine` already performed this check, but resolving again here must not turn a symlink
    // changed between the two operations into an out-of-project identity.
    if !resolved_ancestor.starts_with(&root_canonical) {
        return Err(ConfineError::Escapes);
    }
    let resolved = resolved_ancestor.join(missing_tail);
    let rel = resolved
        .strip_prefix(&root_canonical)
        .map_err(|e| ConfineError::Io(e.to_string()))?;
    Ok(rel.to_string_lossy().replace('\\', "/"))
}

/// Walks up from `path` until it finds a component that actually exists on disk — the leaf of an
/// as-yet-uncreated save target won't, but confinement still needs *some* real path to canonicalize.
fn deepest_existing_ancestor(path: &Path) -> PathBuf {
    let mut current = path.to_path_buf();
    loop {
        if current.exists() {
            return current;
        }
        match current.parent() {
            Some(parent) => current = parent.to_path_buf(),
            None => return current,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn canonical_relative_leaves_an_already_canonical_path_alone() {
        assert_eq!(canonical_relative("notes/outline.md"), "notes/outline.md");
        assert_eq!(canonical_relative("outline.md"), "outline.md");
    }

    #[test]
    fn canonical_relative_normalizes_the_spellings_confine_accepts() {
        // `confine` treats all of these as one file, so the app must too — a tab keyed on
        // `notes/outline.md` has to match a delivery the agent spelled any of these ways.
        assert_eq!(canonical_relative("./notes/outline.md"), "notes/outline.md");
        assert_eq!(canonical_relative("notes/./outline.md"), "notes/outline.md");
        assert_eq!(canonical_relative("notes//outline.md"), "notes/outline.md");
    }

    #[cfg(windows)]
    #[test]
    fn canonical_relative_rewrites_windows_separators_to_forward_slashes() {
        assert_eq!(canonical_relative(r"notes\outline.md"), "notes/outline.md");
        assert_eq!(
            canonical_relative(r".\notes\outline.md"),
            "notes/outline.md"
        );
    }

    #[cfg(unix)]
    #[test]
    fn canonical_relative_keeps_a_backslash_that_is_part_of_a_unix_filename() {
        // On unix a backslash is an ordinary character in a filename, not a separator — rewriting
        // it would rename the file. Platform-correct because it defers to `Path`, as `confine` does.
        assert_eq!(canonical_relative(r"notes\outline.md"), r"notes\outline.md");
    }

    #[test]
    fn a_plain_relative_path_confines_inside_root() {
        let dir = TempDir::new().unwrap();
        let confined = confine(dir.path(), "notes/outline.md").unwrap();
        assert_eq!(
            confined,
            dir.path().canonicalize().unwrap().join("notes/outline.md")
        );
    }

    #[test]
    fn an_empty_path_is_rejected() {
        let dir = TempDir::new().unwrap();
        assert_eq!(confine(dir.path(), "").unwrap_err(), ConfineError::Empty);
    }

    #[test]
    fn a_null_byte_is_rejected() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            confine(dir.path(), "a\0b.md").unwrap_err(),
            ConfineError::NullByte
        );
    }

    #[test]
    fn an_absolute_path_is_rejected() {
        let dir = TempDir::new().unwrap();
        let abs = if cfg!(windows) {
            "C:\\evil.md"
        } else {
            "/etc/evil.md"
        };
        assert_eq!(
            confine(dir.path(), abs).unwrap_err(),
            ConfineError::Absolute
        );
    }

    #[test]
    fn a_parent_traversal_is_rejected() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            confine(dir.path(), "../escape.md").unwrap_err(),
            ConfineError::ParentTraversal
        );
    }

    #[test]
    fn a_parent_traversal_buried_mid_path_is_also_rejected() {
        let dir = TempDir::new().unwrap();
        assert_eq!(
            confine(dir.path(), "notes/../../escape.md").unwrap_err(),
            ConfineError::ParentTraversal
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_directory_escaping_root_is_rejected() {
        let root = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        let link = root.path().join("escape");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();
        assert_eq!(
            confine(root.path(), "escape/file.md").unwrap_err(),
            ConfineError::Escapes
        );
    }

    #[test]
    fn a_not_yet_existing_leaf_is_still_confined_by_its_existing_ancestor() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("chapters")).unwrap();
        let confined = confine(dir.path(), "chapters/new-file.md").unwrap();
        assert_eq!(
            confined,
            dir.path()
                .canonicalize()
                .unwrap()
                .join("chapters/new-file.md")
        );
    }

    #[test]
    fn identity_relative_keys_a_confined_path_on_its_project_relative_spelling() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("notes")).unwrap();
        fs::write(dir.path().join("notes/outline.md"), "hi").unwrap();
        let confined = confine(dir.path(), "./notes/outline.md").unwrap();
        assert_eq!(
            identity_relative(dir.path(), &confined).unwrap(),
            "notes/outline.md"
        );
    }

    #[test]
    fn identity_relative_falls_back_to_the_confined_spelling_for_a_missing_file() {
        // A save target that does not exist yet still has exactly one right key.
        let dir = TempDir::new().unwrap();
        let confined = confine(dir.path(), "new.md").unwrap();
        assert_eq!(identity_relative(dir.path(), &confined).unwrap(), "new.md");
    }

    #[cfg(unix)]
    #[test]
    fn identity_relative_resolves_an_existing_alias_before_appending_a_missing_tail() {
        let dir = TempDir::new().unwrap();
        fs::create_dir(dir.path().join("real")).unwrap();
        std::os::unix::fs::symlink(dir.path().join("real"), dir.path().join("link")).unwrap();
        let confined = confine(dir.path(), "link/new/outline.md").unwrap();

        assert_eq!(
            identity_relative(dir.path(), &confined).unwrap(),
            "real/new/outline.md"
        );
    }

    #[test]
    fn a_missing_root_is_a_defined_io_error_not_a_panic() {
        let dir = TempDir::new().unwrap();
        let missing_root = dir.path().join("does-not-exist");
        assert!(matches!(
            confine(&missing_root, "doc.md"),
            Err(ConfineError::Io(_))
        ));
    }
}
