// ABOUTME: Crate-wide test-only helpers that belong to no one module — a recursive directory
// ABOUTME: listing and a real-second-process harness. Never compiled into a release build.

//! Helpers shared by unit tests in *different* modules, where homing them in whichever module
//! needed them first would be arbitrary (a generic directory walk has nothing to do with locking,
//! or with `.gitignore` maintenance; killing a child process has nothing to do with tab sessions).
//! Anything used by exactly one module stays in that module's own `#[cfg(test)] mod tests`.

use std::ffi::OsStr;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::LazyLock;
use std::time::Duration;

/// Every path under `dir`, relative to it, `/`-separated and sorted — the shape an **allowlist**
/// assertion needs, so a test can state what a directory *may* contain rather than enumerating what
/// it must not. A directory that does not exist is an empty tree, not an error.
///
/// `skip_dir` names directories not to descend into, by file name (they are still listed). Build
/// output is the reason it exists: walking `target/` costs seconds and contains no first-party
/// source.
pub fn tree_skipping(dir: &Path, skip_dir: &dyn Fn(&str) -> bool) -> Vec<String> {
    let mut found = Vec::new();
    collect(dir, dir, skip_dir, &mut found);
    found.sort();
    found
}

/// [`tree_skipping`] over the whole tree.
pub fn tree(dir: &Path) -> Vec<String> {
    tree_skipping(dir, &|_| false)
}

/// [`tree`] with each file's bytes (`None` for a directory), so a test can prove a directory was
/// neither written nor deleted, not merely that the same names still exist.
pub fn tree_with_contents(dir: &Path) -> Vec<(String, Option<Vec<u8>>)> {
    tree(dir)
        .into_iter()
        .map(|relative| {
            let path = dir.join(&relative);
            let bytes = path.is_file().then(|| fs::read(&path).unwrap());
            (relative, bytes)
        })
        .collect()
}

fn collect(root: &Path, dir: &Path, skip_dir: &dyn Fn(&str) -> bool, found: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        found.push(relative_to(root, &path));
        let name = entry.file_name();
        if path.is_dir() && !skip_dir(&name.to_string_lossy()) {
            collect(root, &path, skip_dir, found);
        }
    }
}

fn relative_to(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// A file the crate-wide source scan must always reach. Every assertion built on
/// [`shipped_sources_naming`] is a claim about the scanned set, which a scan that silently reached
/// nothing would satisfy vacuously.
const SOURCE_SCAN_SENTINEL: &str = "src/store/lock.rs";

/// Every shipped `.rs` file under the backend crate, as (repo-relative path, contents). Read once
/// per test binary: the walk plus a full read of every source file is measurable, and each
/// caller-set assertion would otherwise repeat it. Build output is skipped — generated, not
/// shipped, and walking it costs seconds.
static SHIPPED_SOURCES: LazyLock<Vec<(String, String)>> = LazyLock::new(|| {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let sources: Vec<(String, String)> = tree_skipping(&root, &|name| name == "target")
        .into_iter()
        .filter(|entry| entry.ends_with(".rs"))
        .filter_map(|entry| {
            fs::read_to_string(root.join(&entry))
                .ok()
                .map(|text| (entry, text))
        })
        .collect();
    assert!(
        sources.iter().any(|(path, _)| path == SOURCE_SCAN_SENTINEL),
        "the source scan did not reach {SOURCE_SCAN_SENTINEL}, so every assertion over it would be vacuous"
    );
    sources
});

/// Repo-relative paths of the shipped backend sources whose text contains `needle`, excluding
/// `self_path` — the asserting module's own file, which necessarily names anything it looks for.
///
/// The mechanism behind a **caller-set** test. "Exactly these files may name X" is a property of
/// the source tree rather than of any one call, so it is checked by reading the tree. It is the
/// weaker of the two available mechanisms — module privacy would enforce a caller set by
/// construction — and is used only where privacy cannot express the claim: `store::gitignore` pins
/// a caller set across `store::` siblings, and `store::project_identity` pins a property of the
/// whole crate ("only these files hash their own bytes") that no visibility modifier can state.
pub fn shipped_sources_naming(needle: &str, self_path: &str) -> Vec<String> {
    assert!(
        SHIPPED_SOURCES.iter().any(|(path, _)| path == self_path),
        "the source scan did not reach {self_path}, so excluding it below is untested"
    );
    SHIPPED_SOURCES
        .iter()
        .filter(|(path, text)| path != self_path && text.contains(needle))
        .map(|(path, _)| path.clone())
        .collect()
}

/// How long a spawned helper gets to announce itself before [`spawn_ignored_test`] gives up. Long
/// enough for a debug-build test binary to start and bind a loopback listener on a loaded CI box,
/// short enough that a wedged child fails the suite instead of hanging it.
const CHILD_READY_BOUND: Duration = Duration::from_secs(30);

/// A child process a test owns: killed and reaped on drop, so an assertion that unwinds cannot
/// leave it running. Kill it explicitly when the test's *point* is what a dead process leaves
/// behind; the drop is the safety net, not the mechanism.
pub struct TestChild(pub Child);

impl Drop for TestChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Runs one `#[ignore]`d helper test of *this* test binary in a real second process, returning once
/// it prints `ready_marker` on stdout. A genuinely separate process is the only way to assert what
/// an abrupt process exit leaves behind — an OS lock or lease released with no cleanup code able to
/// run — which no in-process test can observe.
///
/// The wait is **bounded** ([`CHILD_READY_BOUND`]): a child that starts and then blocks before
/// announcing panics here rather than hanging the whole suite for as long as CI allows. The child's
/// stdin is left piped and open, which is how the helper parks until it is killed.
pub fn spawn_ignored_test(
    test_path: &str,
    env: &[(&str, &OsStr)],
    ready_marker: &str,
) -> TestChild {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--ignored", "--exact", test_path, "--nocapture"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = TestChild(command.spawn().unwrap());

    let mut reader = BufReader::new(child.0.stdout.take().unwrap());
    let marker = ready_marker.to_string();
    let (announced, ready) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        loop {
            match reader.read_line(&mut line) {
                // The child died; the dropped sender is what `recv_timeout` reports.
                Ok(0) | Err(_) => return,
                Ok(_) if line.contains(&marker) => {
                    let _ = announced.send(());
                    return;
                }
                Ok(_) => line.clear(),
            }
        }
    });
    ready.recv_timeout(CHILD_READY_BOUND).unwrap_or_else(|_| {
        panic!(
            "{test_path} neither announced {ready_marker} nor exited within {CHILD_READY_BOUND:?}"
        )
    });
    child
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn a_directory_that_does_not_exist_is_an_empty_tree_not_an_error() {
        let dir = TempDir::new().unwrap();

        assert!(tree(&dir.path().join("absent")).is_empty());
    }

    #[test]
    fn a_tree_lists_nested_paths_relative_to_its_root_with_forward_slashes() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("a/b")).unwrap();
        fs::write(dir.path().join("a/b/c.txt"), "").unwrap();

        assert_eq!(
            tree(dir.path()),
            vec!["a".to_string(), "a/b".to_string(), "a/b/c.txt".to_string()]
        );
    }

    #[test]
    fn a_skipped_directory_is_listed_but_never_descended_into() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("target/deep")).unwrap();
        fs::write(dir.path().join("target/deep/huge.bin"), "").unwrap();

        assert_eq!(
            tree_skipping(dir.path(), &|name| name == "target"),
            vec!["target".to_string()]
        );
    }
}
