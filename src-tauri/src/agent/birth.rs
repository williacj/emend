// ABOUTME: The frontend-facing shape of a landed `create_document` call (#420, J2 Phase B) —
// ABOUTME: `DocumentBirthNotice` plus the `DocumentBirthObserver` seam `agent::state` raises it through.

//! Mirrors `agent::delivery`'s J1 Phase B pipe (#346) for J2's document birth (FR-CHAT-2): a
//! `create_document` write lands atomically on its own MCP-server thread with no route back to the
//! frontend on its own, so this is the notification half — the caller that owns the project's MCP
//! binding supplies an observer that carries each notice onward, exactly as `DeliveryObserver` does
//! for `propose_changes`.
//!
//! Kept as its own small trait/notice pair rather than folded into [`DeliveryObserver`]: the two
//! concerns are announced from different tool calls with genuinely different payloads (a whole
//! rebased document vs. a bare path + size), and `timeline/types.ts`'s own extension contract — "a
//! new kind + renderer, never a hardcoded list" — is the same "extend, don't overload" shape this
//! mirrors on the backend.
//!
//! [`DeliveryObserver`]: super::delivery::DeliveryObserver

use serde::Serialize;

/// A freshly created document, addressed to the frontend. Mirrored in TS as
/// `stores/documentBirth.ts`'s `DocumentBirthNotice` (CLAUDE.md: cross-boundary types are defined
/// in Rust with `Serialize` and mirrored there), hence the camelCase wire names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
// @anchor:document-birth-notice
pub struct DocumentBirthNotice {
    /// The created document, project-relative in the app's canonical spelling (forward slashes, no
    /// `.` segments) — matches `create_document`'s own normalized response `path` exactly (the
    /// value the app opens as a tab through the existing tab machinery, P2a-6).
    pub path: String,
    /// The written content's size in bytes — the J2 birth card's own field; deliberately not a doc
    /// kind or `via skill:` attribution, since `create_document(path, content)` carries neither and
    /// no ratified channel supplies them (issue #420 scope note: render what the tool actually
    /// carries, never invent tool fields for the card).
    pub size: u64,
}

/// The seam a landed `create_document` is announced through (mirrors `delivery::DeliveryObserver`).
/// `agent::state`'s [`McpContext`] holds one optionally, and the app supplies the implementation
/// that carries the notice to the frontend.
///
/// [`McpContext`]: crate::agent::state::McpContext
pub trait DocumentBirthObserver: Send + Sync {
    /// Called once per successfully created document, after the atomic write, on the MCP server's
    /// own thread. Implementations must not block: the agent's `create_document` call does not
    /// return until this does.
    fn created(&self, notice: &DocumentBirthNotice);
}
