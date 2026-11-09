// ABOUTME: Guards the one invariant every hand-rolled loopback HTTP endpoint in this workspace
// ABOUTME: shares — a connection's socket is read through a borrow, never a duplicated handle.

use std::fs;
use std::path::{Path, PathBuf};

/// Duplicating a socket handle is banned in this workspace, and the ban is worth a permanent test
/// because the failure it prevents is invisible on every platform but one and only shows up as a
/// rare, misattributed flake.
///
/// On Windows the handle `TcpStream`'s clone operation hands back is briefly inheritable. Rust's
/// `std::process::Command` always calls `CreateProcess` with `bInheritHandles: TRUE`, and this
/// process spawns agent CLIs *while* the MCP server is serving — so a spawn racing that window
/// leaks the live connection into the child. The server's own `closesocket` is then no longer the
/// last reference to the socket, so no `FIN` goes out; when the child later exits, the kernel
/// tears the socket down **abortively** and the peer gets an `RST` instead of a clean EOF after an
/// already-complete response. Measured at ~1-3 in 1000 requests under concurrent spawning, which
/// is exactly the rate that reads as "the Windows runner is flaky" rather than as a defect.
///
/// `BufReader::new(&stream)` reads the same bytes with one handle per connection and no race —
/// `impl Read for &TcpStream` exists precisely so the duplicate is unnecessary.
///
/// **The ban is deliberately unconditional**, not scoped to files that mention a socket type. An
/// earlier form required the socket type and the clone call to appear in the same file, which
/// missed the case that matters most: a helper receiving an already-typed stream (`impl Read`, a
/// type alias, a value returned from another module) that never spells the socket type at all.
/// File-descriptor duplication can deliberately reproduce lease retention (#2415). One exact,
/// fully qualified File-only test helper is allowed; its containing file remains scanned, and
/// any second clone call or a socket-typed near-match still fails. Future non-socket cases need
/// their own conscious amendment rather than weakening the socket guard.
#[test]
fn no_socket_is_read_through_a_duplicated_handle() {
    let banned = banned_call();
    let offenders: Vec<String> = rust_sources()
        .into_iter()
        .filter(|path| {
            let source = fs::read_to_string(path).expect("read a workspace source file");
            contains_handle_clone(path, &source)
        })
        .map(|path| display_relative(&path))
        .collect();

    assert!(
        offenders.is_empty(),
        "these files duplicate a handle with `{banned}`. On a socket that is a Windows defect: the \
         duplicate is briefly inheritable, a concurrently spawned child inherits the live \
         connection, and the close turns abortive — the peer sees an RST, not EOF. Read through \
         `BufReader::new(&stream)` instead. If this is genuinely not a socket, amend this test \
         rather than working around it:\n  {}",
        offenders.join("\n  ")
    );
}

/// Permit only the retained-file-descriptor probe in the tab writer's tests. Replacing one exact
/// typed function keeps any other clone in that same file visible to the unconditional scan.
fn contains_handle_clone(path: &Path, source: &str) -> bool {
    let source = strip_comments(source);
    let source = if path == manifest_dir().join("src/commands/tabs.rs") {
        source.replacen(&file_lease_probe(), "", 1)
    } else {
        source
    };
    source.contains(&banned_call())
}

fn file_lease_probe() -> String {
    format!(
        "    fn retain_lease_descriptor(lease: &std::fs::File) -> std::fs::File {{\n        lease.{}().unwrap()\n    }}",
        banned_call()
    )
}

#[test]
fn the_file_lease_probe_does_not_exempt_other_handle_clones() {
    let path = manifest_dir().join("src/commands/tabs.rs");
    let probe = file_lease_probe();
    assert!(!contains_handle_clone(&path, &probe));
    let extra = format!(
        "{probe}\nlet duplicate = stream.{}().unwrap();",
        banned_call()
    );
    assert!(
        contains_handle_clone(&path, &extra),
        "an additional socket clone must remain banned"
    );
    assert!(
        contains_handle_clone(
            &path,
            &probe.replace("std::fs::File", "std::net::TcpStream")
        ),
        "a socket-typed near-match must remain banned"
    );
    assert!(
        contains_handle_clone(&manifest_dir().join("src/other.rs"), &probe),
        "the exception must stay local to the lease test helper"
    );
    assert!(
        contains_handle_clone(&path, &format!("{probe}\n{probe}")),
        "a second copy must remain visible to the scan"
    );
}

/// The banned call, assembled at runtime so **this file does not itself contain the text it
/// searches for**. That is what lets the scan cover every source file with no self-exemption — and
/// an exemption is exactly the kind of hole that would later shadow a real violation (an earlier
/// form skipped any file merely *named* like this one).
fn banned_call() -> String {
    format!("try{}clone", "_")
}

/// Drops line comments (`//`, `///`, `//!`) so the ban is judged on code alone — the prose that
/// *explains* the ban describes the banned call, and must not read as a violation of it. This
/// workspace's style uses no block comments, so line-stripping is sufficient.
fn strip_comments(source: &str) -> String {
    source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Every `.rs` file this workspace owns. Walks the package root rather than an allowlist of
/// directories, so `build.rs`, `benches/`, and any directory added later are covered without this
/// test needing to know about them. Cargo's `target/` is skipped (generated and vendored sources).
fn rust_sources() -> Vec<PathBuf> {
    let mut found = Vec::new();
    collect_rust_files(&manifest_dir(), &mut found);
    assert!(
        !found.is_empty(),
        "found no workspace sources to scan — the walk is broken, not the invariant"
    );
    found
}

fn collect_rust_files(dir: &Path, found: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().is_some_and(|name| name == "target") {
                continue;
            }
            collect_rust_files(&path, found);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            found.push(path);
        }
    }
}

fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn display_relative(path: &Path) -> String {
    path.strip_prefix(manifest_dir())
        .unwrap_or(path)
        .display()
        .to_string()
}
