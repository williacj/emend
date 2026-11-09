// ABOUTME: Store — sidecar schemas + folds (§3.1): comment event logs and the
// ABOUTME: track-changes attribution store. Textops owns the pure text/anchor math these embed.

pub mod adoption;
pub(crate) mod atomic;
pub mod changes;
pub mod comments;
pub mod docs_map;
pub mod gitignore;
pub mod import_v1;
pub mod lock;
pub mod project_identity;
#[cfg(test)]
pub mod schema;
pub mod service;
pub mod settings;
pub mod tab_session;
pub mod transcript;
pub mod watch;
