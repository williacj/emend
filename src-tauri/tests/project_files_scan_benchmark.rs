// ABOUTME: Integration coverage for the real TD-18 filesystem scanner seam used by its tracked benchmark.
// ABOUTME: Proves the external benchmark target can drive production enumeration and count its visible rows.

use std::fs;

use emend_lib::project_files::{
    EntryKind, FilesystemScanner, ProjectFileEntry, ProjectFilesScanner,
};

#[test]
fn benchmark_target_can_drive_the_real_scanner_and_count_every_generated_visible_file() {
    let root = tempfile::tempdir().expect("create benchmark fixture root");
    for directory_index in 0..2 {
        let directory = root.path().join(format!("section-{directory_index:02}"));
        fs::create_dir(&directory).expect("create visible fixture directory");
        for file_index in 0..3 {
            fs::write(
                directory.join(format!("document-{file_index:02}.md")),
                b"benchmark fixture\n",
            )
            .expect("create visible fixture file");
        }
    }

    let entries = FilesystemScanner
        .scan(root.path())
        .expect("the production scanner should enumerate its generated fixture");

    assert_eq!(count_files(&entries), 6);
}

fn count_files(entries: &[ProjectFileEntry]) -> usize {
    entries
        .iter()
        .map(|entry| usize::from(entry.kind == EntryKind::File) + count_files(&entry.children))
        .sum()
}
