// ABOUTME: The frontend-facing shape of a landed `propose_changes` delivery (#346) — `DeliveryNotice`
// ABOUTME: plus the `DeliveryObserver` seam `agent::state` raises it through once a set is fully on disk.

//! The J1 Phase B seam. `propose_changes` (P2a-13) lands a change set atomically on disk and answers
//! the *agent* with a partitioned response; nothing in that path tells the *app* anything happened.
//! This module is the notification half: a [`DeliveryNotice`] carrying exactly what the two frontend
//! surfaces need — the delivered document text and revision (so an open editor can reseed its buffer
//! and tracked-change set through `editor/delivery.ts`'s `applyAgentDelivery`), and the change-set
//! identity, summary and per-change attribution (so `timeline/ChangeSetCard` can render the card).
//!
//! **Ordering is the invariant, not a detail.** `agent::state` raises a notice only *after* the
//! atomic write, and only when something actually landed: FR-AGENT-6 says a delivery is observable
//! as a complete attributed set or not at all, so a listener that reacts by reading the document can
//! never catch the pre-delivery text, and a wholly-stale delivery (nothing applied) raises nothing
//! rather than an empty change-set card.
//!
//! **TD-7 honesty travels with the notice.** A partially-stale delivery is still one complete
//! attributed set — the applied subset — and [`DeliveryNotice::stale`] / `unrepresentable` carry the
//! counts that did not land, so the card can say what was applied instead of implying the whole
//! proposal was.

use serde::Serialize;

use crate::store::changes::ChangeType;

/// One change in a delivered set, as the frontend sees it: its attribution id (TD-4
/// `ChangeRecord.id`), which CriticMarkup marker it is, the agent's per-edit note, and the group it
/// decides all-or-none with (P4b).
///
/// The frontend re-derives each marker's *geometry* from [`DeliveryNotice::content`] via the same
/// `parse_changes` path a document open already uses (TD-2: the text is the truth) — but it still
/// has to know which of that parse's changes belong to *this* delivery, since a delivered document
/// generally also carries markers from earlier ones. [`change_id`](Self::change_id) is that join:
/// since TD-16 the parse reports each recorded marker under this very id, so selecting a delivery's
/// own subset is a lookup on the identity both sides already share — no positional reconciliation
/// between two disagreeing schemes, and no assumption that the parse and the notice list up 1:1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveredChange {
    pub change_id: String,
    pub kind: ChangeType,
    pub note: Option<String>,
    // @anchor:delivered-change-group
    pub group: Option<String>,
}

/// A completed delivery, addressed to the frontend. Mirrored in TS as `stores/delivery.ts`'s
/// `DeliveryNotice` (CLAUDE.md: cross-boundary types are defined in Rust with `Serialize` and
/// mirrored there), hence the camelCase wire names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryNotice {
    /// The delivered document, project-relative in the app's canonical spelling (forward slashes,
    /// no `.` segments) — what the app matches against its open tabs, by exact string equality, to
    /// decide whether this delivery is visible right now. Deliberately *not* the agent's own
    /// spelling: `confine` accepts several spellings of one path and only one matches a tab key.
    pub doc: String,
    /// The delivery's change-set id (`cs-…`), linking the card to every change's attribution record.
    pub change_set_id: String,
    /// The revision the document now carries (TD-6), i.e. the hash of [`content`](Self::content).
    pub revision: String,
    /// The delivered document text, CriticMarkup and all — the whole rebased, TD-11-validated
    /// result the atomic write just put on disk. Carried on the notice rather than re-read by the
    /// frontend so what the buffer reseeds from is exactly what landed, with no second read to race.
    pub content: String,
    /// The agent's own summary of the revision — the change-set card's headline.
    pub summary: String,
    /// The applied subset, in proposal order.
    pub changes: Vec<DeliveredChange>,
    /// How many proposal edits could not be rebased onto the live document (TD-7).
    pub stale: usize,
    /// How many were refused as unrepresentable in CriticMarkup (TD-11).
    pub unrepresentable: usize,
}

/// The seam a landed delivery is announced through. `agent::state`'s [`McpContext`] holds one
/// optionally, and the app supplies the implementation that carries the notice to the frontend —
/// keeping `agent::state` free of any Tauri dependency and letting tests observe deliveries directly.
///
/// [`McpContext`]: crate::agent::state::McpContext
pub trait DeliveryObserver: Send + Sync {
    /// Called once per landed delivery, after the atomic write, on the MCP server's own thread.
    /// Implementations must not block: the agent's `propose_changes` call does not return until
    /// this does.
    fn delivered(&self, notice: &DeliveryNotice);
}

/// The run-queue-facing fact that at least one tracked change or comment actually persisted.
/// Unlike [`DeliveryObserver`], this carries no frontend payload and covers all three TD-1 delivery
/// tools (`propose_changes`, `add_comments`, and `reply_to_comment`). The distinction is
/// load-bearing for #1420: a provider can announce any of those tools even when the MCP boundary
/// refuses it or a wholly-stale proposal lands nothing.
pub trait DeliveryOutcomeObserver: Send + Sync {
    /// Called only after a delivery outcome has persisted. Implementations should be idempotent:
    /// one run may land more than one delivery before it completes.
    fn landed(&self);
}
