// ABOUTME: Atomic whole-file writes (write-to-temp + rename) so a crash mid-write never tears a
// ABOUTME: file — used by the single-writer sidecars and by the source-of-truth doc save (FR-ED-2).

use std::fs;
#[cfg(test)]
use std::fs::OpenOptions;
use std::io;
use std::path::Path;

#[cfg(test)]
use fs4::FileExt;
use serde::Serialize;

/// Writes `contents` to `path` atomically: write to a sibling `.tmp` file, then `rename` it into
/// place. `rename` within the same directory is atomic on both target filesystems (POSIX
/// `rename(2)`, Windows `MoveFileEx`) — a reader can only ever observe the old complete file or
/// the new complete file, never a partial write. Creates `path`'s parent directories if missing.
///
/// Not a fit for the comment event log (`store::service::append_comment_event`), which is
/// genuinely append-only and uses `OpenOptions::append` instead — this helper is for whole-file,
/// single-writer rewrites: the two sidecars (TD §3.2b `docs.json` and `changes/*.json`) and the
/// document save path (`commands::document::save_document`, FR-ED-2) that must never leave a
/// truncated source-of-truth file behind.
///
/// **Single-writer per path.** The temp is a *fixed* sibling `<name>.tmp`, so two writes racing on
/// the same `path` would collide on it — every caller must serialize writes per path.
/// `SidecarStore` owns that serialization for `docs.json`; the other sidecars are single-writer by
/// TD-4, and the document save path serializes in the editor (`editor/autosave.ts`
/// `createSaveRunner`).
pub fn write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "atomic::write: path has no parent",
        )
    })?;
    fs::create_dir_all(parent)?;

    let mut tmp = path.to_path_buf();
    let tmp_name = match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => format!("{name}.tmp"),
        None => "atomic.tmp".to_string(),
    };
    tmp.set_file_name(tmp_name);

    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Writes through an explicitly separate staging directory on the same filesystem. This is for a
/// destination directory whose native watcher is also allowed to remove unrecognized entries: the
/// incomplete file must never appear inside that watched namespace. `after_stage` is the narrow
/// deterministic test barrier for the otherwise unobservable write/rename interval. The caller's
/// persistent staging-lane lock is acquired before the staging file becomes visible and held
/// through the rename, so bounded crash-artifact cleanup can skip a live publisher without a
/// create-to-lock race or timing guesses.
#[cfg(test)]
pub(crate) fn write_from_staging_with_hook(
    path: &Path,
    staging_path: &Path,
    staging_lock_path: &Path,
    contents: &[u8],
    after_stage: impl FnOnce(&Path),
) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "atomic::write_from_staging: path has no parent",
        )
    })?;
    let staging_parent = staging_path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "atomic::write_from_staging: staging path has no parent",
        )
    })?;
    fs::create_dir_all(parent)?;
    fs::create_dir_all(staging_parent)?;
    let staging_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(staging_lock_path)?;
    FileExt::lock(&staging_lock)?;
    fs::write(staging_path, contents)?;
    after_stage(staging_path);
    fs::rename(staging_path, path)?;
    let _ = FileExt::unlock(&staging_lock);
    Ok(())
}

/// Serializes `value` as pretty JSON and writes it to `path` atomically — the common shape both
/// `docs.json` (`store::docs_map`) and the track-changes file (`store::service`) share: a small,
/// single-writer, whole-file-rewritten sidecar.
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    write(path, json.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn writes_the_file_with_the_given_contents() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("data.json");
        write(&path, b"hello").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"hello");
    }

    #[test]
    fn overwrites_an_existing_file_completely() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("data.json");
        write(&path, b"first, and much longer").unwrap();
        write(&path, b"second").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"second");
    }

    #[test]
    fn creates_missing_parent_directories() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a/b/c/data.json");
        write(&path, b"nested").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"nested");
    }

    #[test]
    fn an_interrupted_write_leaves_the_original_file_intact() {
        // Crash-safety model: the new bytes are staged in a sibling `.tmp` and only become the
        // target via `rename`. A crash *before* the rename (simulated here by a leftover partial
        // `.tmp` that was never renamed) leaves the target as the old, complete file — never a
        // truncated mix. This is the "no partial writes under simulated crash/interrupt" guarantee.
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("doc.md");
        write(&path, b"the old, complete content").unwrap();

        // A write that died between staging its temp and renaming it into place.
        fs::write(dir.path().join("doc.md.tmp"), b"new content, torn mid-").unwrap();

        assert_eq!(fs::read(&path).unwrap(), b"the old, complete content");
    }

    #[test]
    fn leaves_no_stray_tmp_file_behind_on_success() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("data.json");
        write(&path, b"contents").unwrap();
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("data.json")]);
    }
}
