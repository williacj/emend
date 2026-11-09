// ABOUTME: Tracked TD-18 benchmark of the real ProjectFilesScanner over generated visible trees.
// ABOUTME: Reports warm-cache scan distributions at 1k, 10k, and 50k files without gating normal CI.

//! This is the measurement TD-18 previously lacked: the real production [`FilesystemScanner`]
//! performs metadata classification, stable native identity lookup, file readability probing,
//! hierarchy construction, and sorting over generated trees with exactly 1k, 10k, and 50k visible
//! files. Fixture creation and deletion are outside the timed section. One untimed scan warms the OS
//! cache; the reported distribution contains five complete scans.
//!
//! Run explicitly on a consistent host:
//!
//! ```text
//! cargo bench --bench project_files_scan
//! ```
//!
//! Normal PR and scheduled CI do not run this filesystem benchmark. The self-hosted Windows workflow
//! runs it only on `workflow_dispatch`, which gives operators a durable exact-revision path without
//! turning machine-dependent wall-clock numbers into a merge gate (test-plan §6).

use std::fs;
use std::hint::black_box;
use std::path::Path;
use std::time::Instant;

use cowrite_lib::project_files::{
    EntryKind, FilesystemScanner, ProjectFileEntry, ProjectFilesScanner,
};

const VISIBLE_FILE_COUNTS: [usize; 3] = [1_000, 10_000, 50_000];
const FILES_PER_LEAF_DIRECTORY: usize = 250;
const LEAF_DIRECTORIES_PER_CATEGORY: usize = 10;
const WARMUP_ITERATIONS: usize = 1;
const TIMED_ITERATIONS: usize = 5;

fn main() {
    println!(
        "[bench] project_files_scan context os={} arch={} warmups={} timed_iterations={} files_per_leaf={} leaves_per_category={}",
        std::env::consts::OS,
        std::env::consts::ARCH,
        WARMUP_ITERATIONS,
        TIMED_ITERATIONS,
        FILES_PER_LEAF_DIRECTORY,
        LEAF_DIRECTORIES_PER_CATEGORY,
    );

    for visible_files in VISIBLE_FILE_COUNTS {
        benchmark_tree(visible_files);
    }
}

fn benchmark_tree(visible_files: usize) {
    let fixture = tempfile::tempdir().expect("create project-files benchmark root");
    let expected_directories = generate_visible_tree(fixture.path(), visible_files);
    let scanner = FilesystemScanner;

    for _ in 0..WARMUP_ITERATIONS {
        let snapshot = scanner
            .scan(fixture.path())
            .expect("warm-up scan should enumerate the generated tree");
        assert_snapshot_shape(&snapshot, visible_files, expected_directories);
        black_box(snapshot);
    }

    let mut durations_ms = Vec::with_capacity(TIMED_ITERATIONS);
    for _ in 0..TIMED_ITERATIONS {
        let started = Instant::now();
        let snapshot = scanner
            .scan(fixture.path())
            .expect("timed scan should enumerate the generated tree");
        durations_ms.push(started.elapsed().as_secs_f64() * 1_000.0);
        assert_snapshot_shape(&snapshot, visible_files, expected_directories);
        black_box(snapshot);
    }

    println!(
        "[bench] project_files_scan result visible_files={} visible_directories={} median_ms={:.2} p95_ms={:.2} max_ms={:.2}",
        visible_files,
        expected_directories,
        percentile(&durations_ms, 50.0),
        percentile(&durations_ms, 95.0),
        durations_ms.iter().copied().fold(f64::MIN, f64::max),
    );
}

fn generate_visible_tree(root: &Path, visible_files: usize) -> usize {
    let leaf_count = visible_files.div_ceil(FILES_PER_LEAF_DIRECTORY);
    let category_count = leaf_count.div_ceil(LEAF_DIRECTORIES_PER_CATEGORY);

    for category_index in 0..category_count {
        fs::create_dir(root.join(format!("category-{category_index:03}")))
            .expect("create visible category directory");
    }
    for leaf_index in 0..leaf_count {
        let category_index = leaf_index / LEAF_DIRECTORIES_PER_CATEGORY;
        fs::create_dir(
            root.join(format!("category-{category_index:03}"))
                .join(format!("section-{leaf_index:04}")),
        )
        .expect("create visible leaf directory");
    }
    for file_index in 0..visible_files {
        let leaf_index = file_index / FILES_PER_LEAF_DIRECTORY;
        let category_index = leaf_index / LEAF_DIRECTORIES_PER_CATEGORY;
        fs::write(
            root.join(format!("category-{category_index:03}"))
                .join(format!("section-{leaf_index:04}"))
                .join(format!("document-{file_index:05}.md")),
            b"benchmark fixture\n",
        )
        .expect("create visible benchmark file");
    }

    category_count + leaf_count
}

fn assert_snapshot_shape(
    entries: &[ProjectFileEntry],
    expected_files: usize,
    expected_directories: usize,
) {
    let counts = snapshot_counts(entries);
    assert_eq!(
        counts.files, expected_files,
        "benchmark must scan every generated file"
    );
    assert_eq!(
        counts.directories, expected_directories,
        "benchmark must scan every generated directory",
    );
    assert_eq!(
        counts.warnings, 0,
        "a benchmark fixture warning would make the timing incomparable",
    );
}

#[derive(Default)]
struct SnapshotCounts {
    files: usize,
    directories: usize,
    warnings: usize,
}

fn snapshot_counts(entries: &[ProjectFileEntry]) -> SnapshotCounts {
    let mut counts = SnapshotCounts::default();
    for entry in entries {
        match entry.kind {
            EntryKind::File => counts.files += 1,
            EntryKind::Directory => counts.directories += 1,
            EntryKind::Symlink | EntryKind::Other | EntryKind::Unknown => {}
        }
        counts.warnings += usize::from(entry.warning.is_some());
        let children = snapshot_counts(&entry.children);
        counts.files += children.files;
        counts.directories += children.directories;
        counts.warnings += children.warnings;
    }
    counts
}

fn percentile(samples: &[f64], percentile: f64) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(|left, right| left.partial_cmp(right).expect("durations are never NaN"));
    let index = ((percentile / 100.0) * sorted.len() as f64).floor() as usize;
    sorted[index.min(sorted.len() - 1)]
}
