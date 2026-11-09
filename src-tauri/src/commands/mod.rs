// ABOUTME: Thin IPC commands (§3.1) — validate → call → return, typed errors. The only layer the
// ABOUTME: frontend's `invoke()` reaches; all authority, file I/O, and `textops` calls stay here.

pub mod adoption;
pub mod agent;
pub mod changes;
pub mod comments;
pub mod diagnostics;
pub mod document;
pub mod path_confine;
pub mod project;
pub mod providers;
pub mod settings;
pub mod skills;
pub mod tabs;
pub mod transcript;
pub mod voice;
