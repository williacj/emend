// ABOUTME: Comment event log — TD-4's append-only per-author JSONL schema plus the
// ABOUTME: causal fold into thread state (test-plan P5): buffer-until-parent, deterministic.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use textops::Anchor;

/// Bumped whenever the on-wire event shape changes (TD-4: "every file carries
/// `schema_version`"). Not yet consulted by `fold` — reader-side version handling
/// (e.g. rejecting/migrating an unknown newer version) is P1-13's schema-publishing
/// job; this module only needs the field to exist on every event.
pub const SCHEMA_VERSION: u32 = 1;

/// One line of a `.emend/comments/<doc-hash>/<author>.jsonl` event log (TD-4).
///
/// Append-only: an author's own file only ever grows. `id` is a globally unique
/// token the caller mints (this module doesn't generate them — a UUID/ULID from the
/// writer is expected); `parent_id` names the thread-or-reply this event acts on
/// (`None` only for `Create`, which starts a new thread whose id *is* this event's
/// own `id`). Cross-author causal ordering during `fold` is by `(timestamp, id)`,
/// never by file-arrival order — different authors' files land in whatever order
/// sync delivers them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommentEvent {
    pub schema_version: u32,
    pub id: String,
    pub parent_id: Option<String>,
    pub author: String,
    /// Milliseconds since the Unix epoch, stamped by the author's own clock.
    /// Cross-machine clock skew is expected and handled by `fold`'s
    /// buffer-until-parent mechanism, not by trusting wall-clock order.
    pub timestamp: i64,
    #[serde(flatten)]
    pub kind: EventKind,
}

#[cfg(test)]
mod correction_tests {
    use super::*;

    fn event(
        id: &str,
        parent_id: Option<&str>,
        author: &str,
        timestamp: i64,
        kind: EventKind,
    ) -> CommentEvent {
        CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: id.into(),
            parent_id: parent_id.map(str::to_string),
            author: author.into(),
            timestamp,
            kind,
        }
    }

    #[test]
    fn latest_activity_tracks_comment_reply_edit_and_resolution() {
        let create = event(
            "z-root",
            None,
            "alice",
            10,
            EventKind::Create {
                anchor: None,
                body: "first".into(),
                severity: None,
                skill: None,
                workflow_run: None,
            },
        );
        let reply = event(
            "a-reply",
            Some("z-root"),
            "bob",
            20,
            EventKind::Reply {
                body: "response".into(),
                defense: false,
                published: false,
                run_id: None,
            },
        );
        let edit = event(
            "b-edit",
            Some("a-reply"),
            "bob",
            30,
            EventKind::Revise {
                body: "clearer response".into(),
            },
        );
        let resolve = event("c-resolve", Some("z-root"), "alice", 40, EventKind::Resolve);

        assert_eq!(
            fold([create.clone()]).threads["z-root"].last_activity_at,
            10
        );
        assert_eq!(
            fold([reply.clone(), create.clone()]).threads["z-root"].last_activity_at,
            20
        );
        assert_eq!(
            fold([edit.clone(), create.clone(), reply.clone()]).threads["z-root"].last_activity_at,
            30
        );
        assert_eq!(
            fold([resolve, edit, reply, create]).threads["z-root"].last_activity_at,
            40
        );
    }

    #[test]
    fn revision_and_withdrawal_are_append_only_and_withdrawal_is_terminal() {
        let create = event(
            "c1",
            None,
            "alice",
            1,
            EventKind::Create {
                anchor: None,
                body: "first".into(),
                severity: None,
                skill: None,
                workflow_run: None,
            },
        );
        let revise = event(
            "e1",
            Some("c1"),
            "alice",
            2,
            EventKind::Revise {
                body: "second".into(),
            },
        );
        let withdraw = event("w1", Some("c1"), "alice", 3, EventKind::Withdraw);
        let late_revision = event(
            "e2",
            Some("c1"),
            "alice",
            4,
            EventKind::Revise {
                body: "resurrect".into(),
            },
        );

        let revised = fold([create.clone(), revise.clone()]);
        let current = &revised.threads["c1"];
        assert_eq!(current.body, "second");
        assert_eq!(current.edited_at, Some(2));
        assert_eq!(current.withdrawn_at, None);

        let final_state = fold([late_revision, withdraw, revise, create]);
        let current = &final_state.threads["c1"];
        assert_eq!(current.body, "");
        assert_eq!(current.withdrawn_at, Some(3));
    }

    #[test]
    fn only_the_direct_targets_author_can_correct_a_reply_after_causal_buffering() {
        let create = event(
            "c1",
            None,
            "alice",
            1,
            EventKind::Create {
                anchor: None,
                body: "root".into(),
                severity: None,
                skill: None,
                workflow_run: None,
            },
        );
        let reply = event(
            "r1",
            Some("c1"),
            "bob",
            5,
            EventKind::Reply {
                body: "first".into(),
                defense: false,
                published: false,
                run_id: None,
            },
        );
        let forged = event(
            "e1",
            Some("r1"),
            "alice",
            6,
            EventKind::Revise {
                body: "forged".into(),
            },
        );
        let revise = event(
            "e2",
            Some("r1"),
            "bob",
            2,
            EventKind::Revise {
                body: "fixed".into(),
            },
        );
        let withdraw = event("w1", Some("r1"), "bob", 7, EventKind::Withdraw);
        let after = fold([withdraw, forged, revise, reply, create]);
        let thread = &after.threads["c1"];
        assert_eq!(thread.body, "root");
        assert_eq!(thread.replies.len(), 1);
        assert_eq!(thread.replies[0].body, "");
        assert_eq!(thread.replies[0].edited_at, Some(2));
        assert_eq!(thread.replies[0].withdrawn_at, Some(7));
    }

    #[test]
    fn publication_survives_withdrawal_independent_of_event_arrival_order() {
        let create = event(
            "c1",
            None,
            "alice",
            1,
            EventKind::Create {
                anchor: None,
                body: "shared comment".into(),
                severity: None,
                skill: None,
                workflow_run: None,
            },
        );
        let published = event("p1", Some("c1"), "emend", 0, EventKind::Publish);
        let withdrawn = event("w1", Some("c1"), "alice", 3, EventKind::Withdraw);

        let private = fold([create.clone(), withdrawn.clone()]);
        assert!(!private.threads["c1"].published);
        assert!(!private.threads["c1"].keeps_withdrawn_placeholder());

        let shared = fold([withdrawn, published, create]);
        assert!(shared.threads["c1"].published);
        assert_eq!(shared.threads["c1"].withdrawn_at, Some(3));
        assert_eq!(shared.threads["c1"].body, "");
        assert!(shared.threads["c1"].keeps_withdrawn_placeholder());
    }

    #[test]
    fn historical_other_author_reply_keeps_placeholder_but_withdrawn_own_reply_does_not() {
        let create = event(
            "c1",
            None,
            "alice",
            1,
            EventKind::Create {
                anchor: None,
                body: "root".into(),
                severity: None,
                skill: None,
                workflow_run: None,
            },
        );
        let own = event(
            "r1",
            Some("c1"),
            "alice",
            2,
            EventKind::Reply {
                body: "my reply".into(),
                defense: false,
                published: false,
                run_id: None,
            },
        );
        let other = event(
            "r2",
            Some("c1"),
            "bob",
            3,
            EventKind::Reply {
                body: "their reply".into(),
                defense: false,
                published: false,
                run_id: None,
            },
        );
        let own_withdrawn = event("w1", Some("r1"), "alice", 4, EventKind::Withdraw);
        let other_withdrawn = event("w2", Some("r2"), "bob", 5, EventKind::Withdraw);
        let root_withdrawn = event("w3", Some("c1"), "alice", 6, EventKind::Withdraw);

        let private = fold([
            create.clone(),
            own.clone(),
            own_withdrawn.clone(),
            root_withdrawn.clone(),
        ]);
        assert!(!private.threads["c1"].keeps_withdrawn_placeholder());

        let seen = fold([
            create,
            own,
            other,
            own_withdrawn,
            other_withdrawn,
            root_withdrawn,
        ]);
        assert!(seen.threads["c1"].keeps_withdrawn_placeholder());
    }

    #[test]
    fn a_late_live_reply_keeps_private_withdrawn_root_visible() {
        let create = event(
            "c1",
            None,
            "alice",
            1,
            EventKind::Create {
                anchor: None,
                body: "root".into(),
                severity: None,
                skill: None,
                workflow_run: None,
            },
        );
        let withdraw = event("w1", Some("c1"), "alice", 2, EventKind::Withdraw);
        let late_reply = event(
            "r1",
            Some("c1"),
            "alice",
            3,
            EventKind::Reply {
                body: "late".into(),
                defense: false,
                published: false,
                run_id: None,
            },
        );
        let fold = fold([late_reply, withdraw, create]);
        assert!(!fold.threads["c1"].published);
        assert!(fold.threads["c1"].keeps_withdrawn_placeholder());
    }

    #[test]
    fn publication_event_targeting_a_reply_does_not_publish_its_root() {
        let create = event(
            "c1",
            None,
            "alice",
            1,
            EventKind::Create {
                anchor: None,
                body: "root".into(),
                severity: None,
                skill: None,
                workflow_run: None,
            },
        );
        let reply = event(
            "r1",
            Some("c1"),
            "alice",
            2,
            EventKind::Reply {
                body: "reply".into(),
                defense: false,
                published: false,
                run_id: None,
            },
        );
        let malformed_publication = event("p1", Some("r1"), "emend", 3, EventKind::Publish);
        let fold = fold([create, reply, malformed_publication]);
        assert!(!fold.threads["c1"].published);
    }
}

/// Keep (`accept`) or discard (`reject`) a linked tracked change (FR-CMT-7) — mirrors
/// `textops::apply::Decision`/`editor/trackedChanges.ts`'s `Decision`, kept as this module's own
/// type (rather than a `textops` import) since the comment log never touches change *content*,
/// only records the outcome `commands::changes`/the live editor's own accept/reject already
/// decided (P2a-5/P2a-14).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkedChangeDecision {
    Accept,
    Reject,
}

/// How an "Address with AI" run ended without delivering (issue #1381, ux-design.md §2's exit
/// table) — the two [`EventKind`] variants below, and [`Thread::concluded_run`]'s note for
/// whichever fires. `Failed` also covers §2's last exit row: a marker reconciled at load time
/// because no live run answers to it any more (a crash, or an app restart mid-run) reads the same
/// "failed" note the table specifies for that row, not a third outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunConclusion {
    Stopped,
    Failed,
}

/// The most recent address run this thread saw end without delivering, and how — surfaced by
/// [`Thread::concluded_run`] until the thread's next event clears it (see that field's own docs).
#[derive(Clone, Debug, PartialEq)]
pub struct ConcludedRun {
    pub run_id: String,
    pub outcome: RunConclusion,
}

/// Backward-compat default for [`EventKind::Address`]'s `started` field (issue #1778): every
/// `address` event on disk before this field existed came from the single-thread path, which
/// always meant "started" — so a record missing the field reads as `true`, never as a
/// retroactively-demoted batch target.
fn address_started_default() -> bool {
    true
}

/// The event payload, internally tagged on `"type"` (snake_case) so each line is one
/// flat JSON object.
///
/// `Unknown` is serde's `#[serde(other)]` catch-all: a future event type this build
/// doesn't recognize deserializes to `Unknown` instead of failing the whole line,
/// and `fold` silently skips it — "unknown event types skipped, not fatal" (P5).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventKind {
    /// Starts a new thread. `anchor: None` is a document-level comment (FR-CMT-1).
    Create {
        anchor: Option<Anchor>,
        body: String,
        severity: Option<String>,
        skill: Option<String>,
        workflow_run: Option<String>,
    },
    /// A reply to the comment/reply named by `parent_id`. `defense` distinguishes FR-CMT-4's
    /// reply-only defense (no edit) from an ordinary reply; `published` is that defense's
    /// publish-to-external-reviewer flag (FR-CMT-4/D20) — local visibility state only, meaningless
    /// (always `false`) on a non-defense reply. Absent on events written before P2a-19 deserializes
    /// to `false` (`#[serde(default)]`) rather than rejecting the line.
    Reply {
        body: String,
        defense: bool,
        #[serde(default)]
        published: bool,
        /// The run whose reply-only defense this is. Old sidecars omit it and remain readable;
        /// they may conclude a run only when exactly one pending Address is present.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
    },
    /// Supersedes only the target comment or reply body (D24). The original remains in the log.
    Revise { body: String },
    /// Removes the target from the working view without erasing its original event (D24).
    Withdraw,
    /// Records that this root comment reached an external review audience (D20). Append when
    /// review sync publishes it, not when a local writer merely creates or edits the comment.
    /// The fact is permanent so a later withdrawal keeps its already-seen placeholder.
    Publish,
    /// Marks the thread named (transitively, via `parent_id`) resolved.
    Resolve,
    /// Reopens a resolved thread (e.g. FR-CMT-3's reject-reopens).
    Reopen,
    /// Moves the anchor of the thread named (transitively) by `parent_id` — D17
    /// re-anchor landing on the event log; the fuzzy-match algorithm itself is
    /// P1-5a/P1-5b's job, not this module's.
    ReAnchor { anchor: Anchor },
    /// Starts an "Address with AI" run against the thread (FR-CMT-2, ux-design.md J4) — the thread
    /// reads "addressed — pending review" until a [`EventKind::LinkChanges`] or a defense
    /// [`EventKind::Reply`] lands for it (this module doesn't reimplement the run itself — P2a-15's
    /// job — only the pending state a caller starting one records here). `guidance` is the
    /// [Try again — add guidance…] re-delegation note (`None` for a first address); a future
    /// orchestration wiring reads it, plus any rejected `linked_changes` outcomes already on the
    /// thread, as the context it hands the agent.
    ///
    /// `started` is issue #1778's fix: whether *this event itself* is genuine per-thread start
    /// evidence, as opposed to merely targeting the thread for a run whose real per-thread start
    /// this build cannot yet observe (ux-design.md §2 "Batch … Working means started, not
    /// targeted", UXR-Q10/#1122). The single-thread path ([`commands::comments::address_with_ai`])
    /// always passes `true` — dispatch and start are the same event when a run only ever targets
    /// one thread. A batch's own per-thread dispatch
    /// ([`commands::comments::address_all_with_ai`]) passes `false`: nothing behind it yet reports
    /// real per-thread progress (P2a-15), so §2's fallback applies — no thread may claim Working
    /// it cannot observe. Promoting a batch target to started once real per-thread evidence exists
    /// is P2a-15's job: no signal for it reaches this module today, so this build writes no such
    /// promotion and defines no event for one.
    ///
    /// Absent on events written before this field existed — every one of those predates the batch
    /// fallback and always meant "started" (`#[serde(default = "address_started_default")]`,
    /// mirroring `Reply::published`'s identical backward-compat default).
    Address {
        run_id: String,
        guidance: Option<String>,
        #[serde(default = "address_started_default")]
        started: bool,
    },
    /// The run named by `run_id` ended without delivering because the user stopped it from the run
    /// card (issue #1381, ux-design.md §2's exit table: "Run stopped by the user"). Matched against
    /// [`Thread::pending_run`] exactly — a stale event for a run this thread has since moved past
    /// (e.g. a re-delegation already minted a new `run_id`) is a no-op, the same tolerance
    /// `LinkChanges`/a defense `Reply` already have for an unmatched target. Clears `pending_run`/
    /// `pending_guidance` and records the outcome on [`Thread::concluded_run`].
    AddressStopped { run_id: String },
    /// [`EventKind::AddressStopped`]'s sibling for a run that ended in failure — a CLI spawn/read
    /// failure, or §2's last exit row: reconciled at load time because no live run answers to
    /// `run_id` any more (a crash, or an app restart mid-run leaves no stop/failure event of its
    /// own to emit). Same matching and clearing as `AddressStopped`; only the recorded outcome and
    /// the card's note differ.
    AddressFailed { run_id: String },
    /// The address run's delivery landing (FR-CMT-2/7): the tracked-change ids `propose_changes`
    /// (P2a-13) proposed, each starting undecided. Always paired with a `Reply` carrying the
    /// agent's explanation (appended alongside, sharing this event's `parent_id`) — this event only
    /// carries the *links*, so the thread's `linked_changes` accumulate across however many address
    /// rounds a thread goes through (re-delegation adds more, it never replaces what's there).
    LinkChanges { change_ids: Vec<String> },
    /// Records one linked change's accept/reject outcome (FR-CMT-7) — decided by whatever
    /// accepted/rejected the tracked change in the live document (P2a-5/P2a-14's mechanism) and
    /// reported back here so the thread can auto-resolve (all decided, ≥1 accepted) or reopen (any
    /// rejected). A `change_id` this thread never linked is a quiet no-op, matching this module's
    /// existing "no matching target: skip" tolerance (e.g. resolving an unknown thread id).
    DecideLinkedChange {
        change_id: String,
        decision: LinkedChangeDecision,
    },
    #[serde(other)]
    Unknown,
}

/// One reply within a folded thread, in causal application order.
#[derive(Clone, Debug, PartialEq)]
pub struct Reply {
    pub id: String,
    /// Direct parent, either the thread root or another reply (FR-CMT-9).
    pub parent_id: String,
    pub author: String,
    pub body: String,
    pub defense: bool,
    pub published: bool,
    pub edited_at: Option<i64>,
    pub withdrawn_at: Option<i64>,
}

/// One linked tracked change's decision state (FR-CMT-7) — `decision: None` is undecided.
///
/// `delivery_id`/`run_id`/`delivered_at` attribute the change to the delivery that produced it
/// (ux-design.md §2, #1380). A thread can accumulate undecided changes from more than one
/// re-delegation (FR-CMT-7), so these three let a caller name each delivery separately wherever
/// §2 requires attribution. `delivery_id` is the `LinkChanges` event's own `id` — unique per delivery,
/// stable grouping key even when `run_id` is absent. `run_id` is the "Address with AI" run that
/// was pending on the thread when that event landed (`Some` for a conforming writer, whose
/// `LinkChanges` always follows its own `Address`; `None` only for a delivery with no preceding
/// `Address` on this thread — tolerated, not expected). `delivered_at` is that event's own
/// `timestamp` (ms since epoch, same clock as `CommentEvent::timestamp`).
#[derive(Clone, Debug, PartialEq)]
pub struct LinkedChange {
    pub change_id: String,
    pub decision: Option<LinkedChangeDecision>,
    pub delivery_id: String,
    pub run_id: Option<String>,
    pub delivered_at: i64,
}

/// A folded comment thread: the derived, current-state view of a `Create` event and
/// everything causally applied to it since (test-plan P5).
#[derive(Clone, Debug, PartialEq)]
pub struct Thread {
    pub id: String,
    pub author: String,
    /// Latest accepted event on this thread, in the sidecar event's millisecond clock.
    pub last_activity_at: i64,
    pub anchor: Option<Anchor>,
    pub body: String,
    pub edited_at: Option<i64>,
    pub withdrawn_at: Option<i64>,
    /// Durable D20 evidence that this root reached a review audience. Local comments start false.
    pub published: bool,
    pub severity: Option<String>,
    // @anchor:thread-birth-provenance
    pub skill: Option<String>,
    pub workflow_run: Option<String>,
    pub resolved: bool,
    pub replies: Vec<Reply>,
    /// Legacy single-run projection: `Some(run_id)` only when exactly one Address remains
    /// pending. With overlap, `pending_addresses` owns the full state and this is `None`.
    // @anchor:thread-pending-run
    pub pending_run: Option<String>,
    /// Pending Address records in causal admission order. A second queued run adds its own
    /// record rather than replacing the earlier run's delivery and terminal identity (J4).
    pub pending_addresses: Vec<PendingAddress>,
    /// Every Address event's causal identity, including concluded runs. A late LinkChanges child
    /// stays attributed to its own run even after that run leaves the pending set.
    pub(crate) address_event_runs: BTreeMap<String, String>,
    /// Run-keyed completion facts seen before their Address under P5 clock skew or tied IDs.
    /// Reply parent_id stays in the comment hierarchy, so this causal edge lives beside it.
    terminal_runs: BTreeMap<String, RunTerminal>,
    /// A successful correction applied after the current Address. It clears an eventual stop/
    /// failure note without discarding the pending run's delivery attribution (P5, J7/J10).
    pending_run_corrected: bool,
    /// Every run that has targeted this thread, retained after delivery clears `pending_run`.
    /// Correction intersects this history with the process queue's live/queued run ids (D24).
    pub targeting_run_ids: BTreeSet<String>,
    /// The Address event that started `pending_run`. A conforming `LinkChanges` writer uses this
    /// event id as its causal parent, so P5's buffer-until-parent rule orders the delivery after
    /// its run even when the two writers' clocks skew or their timestamps tie (#1380 review).
    pub(crate) pending_address_event_id: Option<String>,
    /// The re-delegation note the in-flight run started with ([Try again — add guidance…]),
    /// alongside `pending_run` — `None` for a first address, cleared with it on delivery.
    pub pending_guidance: Option<String>,
    /// Whether `pending_run` has begun genuine per-thread work, as opposed to merely targeting
    /// this thread (issue #1778, ux-design.md §2 "Batch … Working means started, not targeted",
    /// UXR-Q10/#1122) — meaningless while `pending_run` is `None`. Set by
    /// [`EventKind::Address`]'s own `started` flag, its only writer (see that field's doc for why
    /// nothing raises it for a batch target). The frontend's
    /// `deriveThreadState` renders *Working* only when both `pending_run` is set
    /// **and** this is `true` — a batch-targeted-but-not-started thread instead recomputes to
    /// whatever it would otherwise be (open, reopened, …), exactly like a thread with no run at
    /// all, per §2's acknowledgment ladder's "unchanged" rung.
    pub pending_run_started: bool,
    /// The most recent address run to end on this thread *without* delivering — stopped, failed,
    /// or reconciled as failed at load time (issue #1381, ux-design.md §2's exit table) — so the
    /// card can render its exit note (`Address run stopped/failed — nothing proposed for this
    /// comment.`) persistently until the user's next action. Set by [`EventKind::AddressStopped`]/
    /// [`EventKind::AddressFailed`]; cleared by *any* other event reaching this thread afterwards
    /// (a reply, resolve, reopen, re-anchor, a fresh address, or a linked-change decision) — "the
    /// user's next action on the thread" the exit table names for the stopped case, applied
    /// uniformly to the failed case too since nothing in §2 says otherwise. Never set while
    /// `pending_run` is (a live run has nothing concluded yet to report).
    pub concluded_run: Option<ConcludedRun>,
    /// Every tracked change any address round has linked to this thread, oldest first
    /// (FR-CMT-7) — accumulates across re-delegations rather than resetting.
    pub linked_changes: Vec<LinkedChange>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PendingAddress {
    pub run_id: String,
    pub event_id: String,
    pub guidance: Option<String>,
    pub started: bool,
    pub corrected: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RunTerminal {
    Delivered,
    Stopped,
    Failed,
}

impl Thread {
    fn record_run_terminal(&mut self, run_id: &str, terminal: RunTerminal) {
        // Delivery wins over a later stop/failure for the same run. The terminal map also lets
        // a clock-skewed root-parent event conclude an Address that sorts after it under P5.
        let prior = self.terminal_runs.get(run_id).copied();
        if prior != Some(RunTerminal::Delivered) || terminal == RunTerminal::Delivered {
            self.terminal_runs.insert(run_id.to_string(), terminal);
        }
    }

    /// Existing callers keep their single-run projection only when it is unambiguous. P5 sorts
    /// sidecar events by authored time/id, which cannot establish the separate RunQueue's FIFO
    /// order after clock skew, so two pending records project no singular run or status claim.
    fn project_primary_address(&mut self) {
        let primary = (self.pending_addresses.len() == 1)
            .then(|| self.pending_addresses.first())
            .flatten();
        self.pending_run = primary.map(|address| address.run_id.clone());
        self.pending_address_event_id = primary.map(|address| address.event_id.clone());
        self.pending_guidance = primary.and_then(|address| address.guidance.clone());
        self.pending_run_started = primary.is_some_and(|address| address.started);
        self.pending_run_corrected = primary.is_some_and(|address| address.corrected);
    }

    /// A successful authored correction clears any existing run note and marks the current run
    /// for note suppression if its stop/failure event arrives later. The pending marker stays for
    /// attribution if an offline correction races a still-live run's delivery (P5, J7/J10).
    fn correction_landed(&mut self) {
        for address in &mut self.pending_addresses {
            address.corrected = true;
        }
        self.project_primary_address();
        self.concluded_run = None;
    }

    /// Whether a withdrawn root needs a bodyless context line in the working view (J10).
    /// Any historical reply by another actor or any live late reply can outlive its own root.
    pub fn keeps_withdrawn_placeholder(&self) -> bool {
        self.withdrawn_at.is_some()
            && (self.published
                || self.replies.iter().any(|reply| reply.author != self.author)
                || self
                    .replies
                    .iter()
                    .any(|reply| reply.withdrawn_at.is_none()))
    }

    /// A live reply anywhere beneath `target_id` blocks withdrawal of that parent. A withdrawn
    /// intermediate reply does not conceal a late live grandchild from this check.
    pub fn has_live_descendant(&self, target_id: &str) -> bool {
        let parents: HashMap<&str, &str> = self
            .replies
            .iter()
            .map(|reply| (reply.id.as_str(), reply.parent_id.as_str()))
            .collect();
        self.replies
            .iter()
            .filter(|reply| reply.withdrawn_at.is_none())
            .any(|reply| {
                let mut parent = reply.parent_id.as_str();
                let mut seen = HashSet::new();
                loop {
                    if parent == target_id {
                        return true;
                    }
                    if !seen.insert(parent) {
                        return false;
                    }
                    match parents.get(parent) {
                        Some(next) => parent = next,
                        None => return false,
                    }
                }
            })
    }
}

/// The causal fold of a comment event log (test-plan P5). Cross-author events are
/// merged by `(timestamp, id)` order rather than trusted arrival order; an event
/// whose `parent_id` hasn't been applied yet — clock skew, cross-author
/// interleaving, or plain arrival order — buffers until its parent shows up
/// ("dangling references … have deterministic defined semantics: buffer-until-parent",
/// P5); unknown event kinds are skipped rather than failing the fold.
///
/// `Fold` is deliberately re-derived from its *full* observed history on every
/// `apply`, rather than mutated incrementally per event. That is what makes the
/// incremental-sync invariant — `fold(prefix)` then `apply(rest)` equals
/// `fold(all)` — hold **by construction**: `derive` is a pure function of the set
/// of events seen so far, so how those events were batched across `apply` calls
/// cannot change the result.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Fold {
    events: Vec<CommentEvent>,
    pub threads: BTreeMap<String, Thread>,
}

impl Fold {
    pub fn new() -> Fold {
        Fold::default()
    }

    /// Fold a batch of newly observed events into this state, on top of everything
    /// already observed. The order events arrive across `apply` calls (or within a
    /// single call) never affects the result.
    pub fn apply<I: IntoIterator<Item = CommentEvent>>(&mut self, new_events: I) {
        self.events.extend(new_events);
        self.threads = derive(&self.events);
    }
}

/// One-shot fold of a full event set. Equivalent to `Fold::new()` then `apply`.
pub fn fold<I: IntoIterator<Item = CommentEvent>>(events: I) -> Fold {
    let mut state = Fold::new();
    state.apply(events);
    state
}

/// Derive the current thread state from a full set of events, deterministically.
fn derive(events: &[CommentEvent]) -> BTreeMap<String, Thread> {
    // Deterministic total order: (timestamp, id) — id is the tie-break under equal
    // timestamps or clock skew. Never input/arrival order (P5).
    let mut ordered: Vec<&CommentEvent> = events.iter().collect();
    ordered.sort_by(|a, b| (a.timestamp, a.id.as_str()).cmp(&(b.timestamp, b.id.as_str())));

    let mut threads: BTreeMap<String, Thread> = BTreeMap::new();
    // Maps any event id that has been applied (a Create, or a Reply — replies are
    // themselves valid future `parent_id` targets, e.g. reply-to-a-reply) to the
    // thread it belongs to.
    let mut id_to_thread: HashMap<String, String> = HashMap::new();
    // Events buffered on a parent id that hasn't been applied yet.
    let mut pending: HashMap<String, Vec<&CommentEvent>> = HashMap::new();

    for event in ordered {
        apply_if_ready(event, &mut threads, &mut id_to_thread, &mut pending);
    }

    threads
}

/// Apply `event` now if its parent (or, for `Create`, no parent) is available;
/// otherwise buffer it on `parent_id` until that parent is applied.
fn apply_if_ready<'a>(
    event: &'a CommentEvent,
    threads: &mut BTreeMap<String, Thread>,
    id_to_thread: &mut HashMap<String, String>,
    pending: &mut HashMap<String, Vec<&'a CommentEvent>>,
) {
    if matches!(event.kind, EventKind::Unknown) {
        return; // unknown event types: skipped, not fatal (P5)
    }

    let thread_id = match &event.kind {
        EventKind::Create { .. } => Some(event.id.clone()),
        _ => event
            .parent_id
            .as_deref()
            .and_then(|parent| id_to_thread.get(parent).cloned()),
    };

    match thread_id {
        Some(thread_id) => {
            apply_event(event, &thread_id, threads, id_to_thread);
            // This event may itself now be a valid target for buffered children
            // (e.g. a reply-to-this-reply that arrived earlier in causal order).
            if let Some(waiting) = pending.remove(&event.id) {
                for buffered in waiting {
                    apply_if_ready(buffered, threads, id_to_thread, pending);
                }
            }
        }
        None => {
            if let Some(parent_id) = &event.parent_id {
                pending.entry(parent_id.clone()).or_default().push(event);
            }
            // No parent_id and not a Create: malformed for a conforming writer —
            // dropped (there is nothing to buffer on, and no parent to wait for).
        }
    }
}

/// Mutate `threads` for one event already known to target `thread_id`, and record
/// this event's own id as belonging to that thread (so later events can target it).
fn apply_event(
    event: &CommentEvent,
    thread_id: &str,
    threads: &mut BTreeMap<String, Thread>,
    id_to_thread: &mut HashMap<String, String>,
) {
    let mut activity = false;
    match &event.kind {
        EventKind::Create {
            anchor,
            body,
            severity,
            skill,
            workflow_run,
        } => {
            threads.insert(
                event.id.clone(),
                Thread {
                    id: event.id.clone(),
                    author: event.author.clone(),
                    last_activity_at: event.timestamp,
                    anchor: anchor.clone(),
                    body: body.clone(),
                    edited_at: None,
                    withdrawn_at: None,
                    published: false,
                    severity: severity.clone(),
                    skill: skill.clone(),
                    workflow_run: workflow_run.clone(),
                    resolved: false,
                    replies: Vec::new(),
                    pending_run: None,
                    pending_addresses: Vec::new(),
                    address_event_runs: BTreeMap::new(),
                    terminal_runs: BTreeMap::new(),
                    pending_run_corrected: false,
                    targeting_run_ids: BTreeSet::new(),
                    pending_address_event_id: None,
                    pending_guidance: None,
                    pending_run_started: false,
                    concluded_run: None,
                    linked_changes: Vec::new(),
                },
            );
        }
        EventKind::Reply {
            body,
            defense,
            published,
            run_id,
        } => {
            if let Some(thread) = threads.get_mut(thread_id) {
                activity = true;
                thread.replies.push(Reply {
                    id: event.id.clone(),
                    parent_id: event.parent_id.clone().expect("a reply has a parent"),
                    author: event.author.clone(),
                    body: body.clone(),
                    defense: *defense,
                    published: *published,
                    edited_at: None,
                    withdrawn_at: None,
                });
                // A defense is the run's delivery too (FR-CMT-4: no edit proposed) — it concludes
                // whatever address run was pending exactly as a `LinkChanges` delivery does.
                if *defense {
                    if let Some(run_id) = run_id {
                        thread.record_run_terminal(run_id, RunTerminal::Delivered);
                    }
                    let target = run_id
                        .as_ref()
                        .and_then(|id| {
                            thread
                                .pending_addresses
                                .iter()
                                .position(|address| &address.run_id == id)
                        })
                        .or_else(|| {
                            (run_id.is_none() && thread.pending_addresses.len() == 1).then_some(0)
                        });
                    if let Some(position) = target {
                        thread.pending_addresses.remove(position);
                        thread.project_primary_address();
                    }
                }
                // Any reply is "the user's next action on the thread" (issue #1381, ux-design.md
                // §2's exit table) — a stopped/failed run's note doesn't outlive it.
                thread.concluded_run = None;
            }
        }
        EventKind::Revise { body } => {
            if !body.trim().is_empty() {
                if let Some(thread) = threads.get_mut(thread_id) {
                    let target_id = event.parent_id.as_deref();
                    let mut corrected = false;
                    if target_id == Some(thread.id.as_str()) {
                        if thread.author == event.author && thread.withdrawn_at.is_none() {
                            thread.body = body.clone();
                            thread.edited_at = Some(event.timestamp);
                            corrected = true;
                        }
                    } else if let Some(reply) = thread
                        .replies
                        .iter_mut()
                        .find(|r| Some(r.id.as_str()) == target_id)
                    {
                        if reply.author == event.author && reply.withdrawn_at.is_none() {
                            reply.body = body.clone();
                            reply.edited_at = Some(event.timestamp);
                            corrected = true;
                        }
                    }
                    if corrected {
                        activity = true;
                        thread.correction_landed();
                    }
                }
            }
        }
        EventKind::Withdraw => {
            if let Some(thread) = threads.get_mut(thread_id) {
                let target_id = event.parent_id.as_deref();
                let mut corrected = false;
                if target_id == Some(thread.id.as_str()) {
                    if thread.author == event.author && thread.withdrawn_at.is_none() {
                        thread.body.clear();
                        thread.withdrawn_at = Some(event.timestamp);
                        corrected = true;
                    }
                } else if let Some(reply) = thread
                    .replies
                    .iter_mut()
                    .find(|r| Some(r.id.as_str()) == target_id)
                {
                    if reply.author == event.author && reply.withdrawn_at.is_none() {
                        reply.body.clear();
                        reply.withdrawn_at = Some(event.timestamp);
                        corrected = true;
                    }
                }
                if corrected {
                    activity = true;
                    thread.correction_landed();
                }
            }
        }
        EventKind::Publish => {
            if event.parent_id.as_deref() == Some(thread_id) {
                if let Some(thread) = threads.get_mut(thread_id) {
                    activity = true;
                    thread.published = true;
                }
            }
        }
        EventKind::Resolve => {
            if let Some(thread) = threads.get_mut(thread_id) {
                // A legally appended manual Resolve can replay after a later delivery under
                // timestamp ties or clock skew. Never close over undecided work (FR-CMT-21).
                if !thread
                    .linked_changes
                    .iter()
                    .any(|change| change.decision.is_none())
                {
                    activity = true;
                    thread.resolved = true;
                    thread.concluded_run = None;
                }
            }
        }
        EventKind::Reopen => {
            if let Some(thread) = threads.get_mut(thread_id) {
                activity = true;
                thread.resolved = false;
                thread.concluded_run = None;
            }
        }
        EventKind::ReAnchor { anchor } => {
            if let Some(thread) = threads.get_mut(thread_id) {
                activity = true;
                thread.anchor = Some(anchor.clone());
                thread.concluded_run = None;
            }
        }
        EventKind::Address {
            run_id,
            guidance,
            started,
        } => {
            if let Some(thread) = threads.get_mut(thread_id) {
                activity = true;
                thread.targeting_run_ids.insert(run_id.clone());
                thread
                    .address_event_runs
                    .insert(event.id.clone(), run_id.clone());
                if !thread
                    .pending_addresses
                    .iter()
                    .any(|address| address.run_id == *run_id)
                    && !thread.terminal_runs.contains_key(run_id)
                {
                    thread.pending_addresses.push(PendingAddress {
                        run_id: run_id.clone(),
                        event_id: event.id.clone(),
                        guidance: guidance.clone(),
                        started: *started,
                        corrected: false,
                    });
                }
                thread.project_primary_address();
                // A fresh address (first, or re-delegated) is itself the user's next action —
                // supersedes whatever the previous run's note said.
                thread.concluded_run = None;
                if let Some(terminal) = thread.terminal_runs.get(run_id).copied() {
                    if thread.pending_addresses.is_empty() {
                        thread.concluded_run = match terminal {
                            RunTerminal::Delivered => None,
                            RunTerminal::Stopped => Some(ConcludedRun {
                                run_id: run_id.clone(),
                                outcome: RunConclusion::Stopped,
                            }),
                            RunTerminal::Failed => Some(ConcludedRun {
                                run_id: run_id.clone(),
                                outcome: RunConclusion::Failed,
                            }),
                        };
                    }
                }
            }
        }
        EventKind::AddressStopped { run_id } => {
            if let Some(thread) = threads.get_mut(thread_id) {
                thread.record_run_terminal(run_id, RunTerminal::Stopped);
                // Clear the named pending run now, or retain its terminal fact if P5 sorted this
                // root-parent event before its Address. No other pending run is touched.
                if let Some(position) = thread
                    .pending_addresses
                    .iter()
                    .position(|address| address.run_id == *run_id)
                {
                    activity = true;
                    let corrected = thread.pending_addresses.remove(position).corrected;
                    thread.project_primary_address();
                    thread.concluded_run = (!corrected && thread.pending_addresses.is_empty())
                        .then_some(ConcludedRun {
                            run_id: run_id.clone(),
                            outcome: RunConclusion::Stopped,
                        });
                }
            }
        }
        EventKind::AddressFailed { run_id } => {
            if let Some(thread) = threads.get_mut(thread_id) {
                thread.record_run_terminal(run_id, RunTerminal::Failed);
                if let Some(position) = thread
                    .pending_addresses
                    .iter()
                    .position(|address| address.run_id == *run_id)
                {
                    activity = true;
                    let corrected = thread.pending_addresses.remove(position).corrected;
                    thread.project_primary_address();
                    thread.concluded_run = (!corrected && thread.pending_addresses.is_empty())
                        .then_some(ConcludedRun {
                            run_id: run_id.clone(),
                            outcome: RunConclusion::Failed,
                        });
                }
            }
        }
        EventKind::LinkChanges { change_ids } => {
            if let Some(thread) = threads.get_mut(thread_id) {
                activity = true;
                // Captured before clearing: the run this delivery concludes, if any (#1380 —
                // attributes every linked change to the delivery/run that produced it).
                let causal_run = event
                    .parent_id
                    .as_ref()
                    .and_then(|parent| thread.address_event_runs.get(parent))
                    .cloned();
                let target = causal_run
                    .as_ref()
                    .and_then(|run_id| {
                        thread
                            .pending_addresses
                            .iter()
                            .position(|address| &address.run_id == run_id)
                    })
                    .or_else(|| {
                        (causal_run.is_none()
                            && event.parent_id.as_deref() == Some(thread.id.as_str())
                            && thread.pending_addresses.len() == 1)
                            .then_some(0)
                    });
                let pending_run =
                    target.map(|position| thread.pending_addresses.remove(position).run_id);
                let run_id = causal_run.or(pending_run);
                if let Some(run_id) = &run_id {
                    thread.record_run_terminal(run_id, RunTerminal::Delivered);
                }
                thread.project_primary_address();
                thread.concluded_run = None;
                for change_id in change_ids {
                    if !thread
                        .linked_changes
                        .iter()
                        .any(|c| &c.change_id == change_id)
                    {
                        // Only newly proposed work clears a closure. Empty and duplicate-only
                        // delivery records must leave a mid-run manual Resolve standing.
                        thread.resolved = false;
                        thread.linked_changes.push(LinkedChange {
                            change_id: change_id.clone(),
                            decision: None,
                            delivery_id: event.id.clone(),
                            run_id: run_id.clone(),
                            delivered_at: event.timestamp,
                        });
                    }
                }
            }
        }
        EventKind::DecideLinkedChange {
            change_id,
            decision,
        } => {
            if let Some(thread) = threads.get_mut(thread_id) {
                if let Some(linked) = thread
                    .linked_changes
                    .iter_mut()
                    .find(|c| &c.change_id == change_id)
                {
                    activity = true;
                    linked.decision = Some(*decision);
                }
                thread.concluded_run = None;
                // Any rejection immediately unresolves (FR-CMT-3/7: "any rejection reopens the
                // thread") — the completion check just below can still re-resolve it in the same
                // step if, by this decision, every linked change is now decided and at least one
                // (possibly a different one) was accepted: FR-CMT-7's rule is evaluated on the
                // *final* state, a rejection along the way doesn't block it.
                if *decision == LinkedChangeDecision::Reject {
                    thread.resolved = false;
                }
                let all_decided = !thread.linked_changes.is_empty()
                    && thread.linked_changes.iter().all(|c| c.decision.is_some());
                let any_accepted = thread
                    .linked_changes
                    .iter()
                    .any(|c| c.decision == Some(LinkedChangeDecision::Accept));
                if all_decided && any_accepted {
                    thread.resolved = true;
                }
            }
        }
        EventKind::Unknown => unreachable!("filtered out in apply_if_ready before reaching here"),
    }
    if activity {
        if let Some(thread) = threads.get_mut(thread_id) {
            thread.last_activity_at = thread.last_activity_at.max(event.timestamp);
        }
    }
    id_to_thread.insert(event.id.clone(), thread_id.to_string());
}

#[cfg(test)]
mod schema_tests {
    use super::*;

    fn create(id: &str, author: &str, timestamp: i64, body: &str) -> CommentEvent {
        CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: None,
            author: author.to_string(),
            timestamp,
            kind: EventKind::Create {
                anchor: None,
                body: body.to_string(),
                severity: None,
                skill: None,
                workflow_run: None,
            },
        }
    }

    #[test]
    fn comment_event_round_trips_through_json() {
        let event = create("c1", "alice", 100, "please clarify");
        let json = serde_json::to_string(&event).unwrap();
        let back: CommentEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(back, event);
    }

    #[test]
    fn pre_run_id_reply_json_remains_readable_and_defends_one_pending_run() {
        let old_line = r#"{"schema_version":1,"id":"d1","parent_id":"c1","author":"agent","timestamp":2,"type":"reply","body":"No change","defense":true,"published":false}"#;
        let old_reply: CommentEvent = serde_json::from_str(old_line).unwrap();
        assert!(matches!(
            old_reply.kind,
            EventKind::Reply { run_id: None, .. }
        ));
        let state = fold([
            create("c1", "alice", 0, "why?"),
            CommentEvent {
                schema_version: SCHEMA_VERSION,
                id: "a1".into(),
                parent_id: Some("c1".into()),
                author: "you".into(),
                timestamp: 1,
                kind: EventKind::Address {
                    run_id: "run-1".into(),
                    guidance: None,
                    started: true,
                },
            },
            old_reply,
        ]);
        assert!(state.threads["c1"].pending_addresses.is_empty());
        assert_eq!(state.threads["c1"].replies[0].parent_id, "c1");
    }

    #[test]
    fn an_unrecognized_type_tag_deserializes_to_unknown_not_an_error() {
        // A future event kind this build doesn't know about yet — the line must
        // still parse (P5: "unknown event types skipped, not fatal").
        let json = r#"{
            "schema_version": 1,
            "id": "e9",
            "parent_id": "c1",
            "author": "bob",
            "timestamp": 100,
            "type": "some_future_kind",
            "whatever_fields_it_has": 42
        }"#;
        let event: CommentEvent = serde_json::from_str(json).unwrap();
        assert_eq!(event.kind, EventKind::Unknown);
    }
}

#[cfg(test)]
mod conformance_tests {
    // Binds this module's wire shape to the *published* contract (FR-X-8, P1-13):
    // every `CommentEvent` this module can produce must validate against
    // `docs/formats/sidecar/comment-event.schema.json`, and the schema's
    // forward-compatibility promise (P5: unknown types tolerated) must hold too.
    use super::*;
    use crate::store::schema::{is_valid, Schema};

    fn valid(event: &CommentEvent) -> bool {
        is_valid(Schema::CommentEvent, &serde_json::to_value(event).unwrap())
    }

    #[test]
    fn a_create_event_conforms_to_the_published_schema() {
        let event = CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: "c1".to_string(),
            parent_id: None,
            author: "alice".to_string(),
            timestamp: 0,
            kind: EventKind::Create {
                anchor: None,
                body: "why here?".to_string(),
                severity: Some("high".to_string()),
                skill: Some("biblical-accuracy".to_string()),
                workflow_run: Some("run-42".to_string()),
            },
        };
        assert!(valid(&event));
    }

    #[test]
    fn a_create_event_with_an_anchor_conforms_to_the_published_schema() {
        let doc = textops::Document::new("abcdef");
        let event = CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: "c1".to_string(),
            parent_id: None,
            author: "alice".to_string(),
            timestamp: 0,
            kind: EventKind::Create {
                anchor: Some(Anchor::new(&doc, 0, 3)),
                body: "why here?".to_string(),
                severity: None,
                skill: None,
                workflow_run: None,
            },
        };
        assert!(valid(&event));
    }

    #[test]
    fn a_reply_event_conforms_to_the_published_schema() {
        let event = CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: "r1".to_string(),
            parent_id: Some("c1".to_string()),
            author: "bob".to_string(),
            timestamp: 1,
            kind: EventKind::Reply {
                body: "good catch".to_string(),
                defense: false,
                published: false,
                run_id: None,
            },
        };
        assert!(valid(&event));
    }

    #[test]
    fn correction_events_require_their_published_fields() {
        for (kind, id) in [
            (
                EventKind::Revise {
                    body: "fixed".into(),
                },
                "e1",
            ),
            (EventKind::Withdraw, "w1"),
        ] {
            let event = CommentEvent {
                schema_version: SCHEMA_VERSION,
                id: id.into(),
                parent_id: Some("c1".into()),
                author: "alice".into(),
                timestamp: 2,
                kind,
            };
            assert!(valid(&event));
            let mut missing_parent = serde_json::to_value(&event).unwrap();
            missing_parent.as_object_mut().unwrap().remove("parent_id");
            assert!(!is_valid(Schema::CommentEvent, &missing_parent));
        }
        let missing_body = serde_json::json!({
            "schema_version": 1, "id": "e1", "parent_id": "c1",
            "author": "alice", "timestamp": 2, "type": "revise"
        });
        assert!(!is_valid(Schema::CommentEvent, &missing_body));
    }

    #[test]
    fn publication_event_requires_parent_id_in_the_published_schema() {
        let event = CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: "p1".into(),
            parent_id: Some("c1".into()),
            author: "emend".into(),
            timestamp: 2,
            kind: EventKind::Publish,
        };
        assert!(valid(&event));
        let mut missing_parent = serde_json::to_value(event).unwrap();
        missing_parent.as_object_mut().unwrap().remove("parent_id");
        assert!(!is_valid(Schema::CommentEvent, &missing_parent));
    }

    #[test]
    fn resolve_and_reopen_events_conform_to_the_published_schema() {
        for kind in [EventKind::Resolve, EventKind::Reopen] {
            let event = CommentEvent {
                schema_version: SCHEMA_VERSION,
                id: "s1".to_string(),
                parent_id: Some("c1".to_string()),
                author: "alice".to_string(),
                timestamp: 2,
                kind,
            };
            assert!(valid(&event));
        }
    }

    #[test]
    fn a_re_anchor_event_conforms_to_the_published_schema() {
        let doc = textops::Document::new("abcdef");
        let event = CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: "a1".to_string(),
            parent_id: Some("c1".to_string()),
            author: "alice".to_string(),
            timestamp: 4,
            kind: EventKind::ReAnchor {
                anchor: Anchor::new(&doc, 0, 3),
            },
        };
        assert!(valid(&event));
    }

    #[test]
    fn an_unknown_event_still_conforms_to_the_published_schema() {
        // P5 forward-compat: a future event type must still validate against the
        // published contract, not just deserialize — this is what makes the
        // schema itself the drift canary, not only this build's `Unknown` variant.
        let value = serde_json::json!({
            "schema_version": 1,
            "id": "e9",
            "parent_id": "c1",
            "author": "bob",
            "timestamp": 100,
            "type": "some_future_kind",
            "whatever_fields_it_has": 42
        });
        assert!(is_valid(Schema::CommentEvent, &value));
    }

    #[test]
    fn a_reply_missing_its_required_parent_id_is_rejected() {
        let value = serde_json::json!({
            "schema_version": 1,
            "id": "r1",
            "author": "bob",
            "timestamp": 1,
            "type": "reply",
            "body": "good catch",
            "defense": false
        });
        assert!(!is_valid(Schema::CommentEvent, &value));
    }

    #[test]
    fn a_defense_reply_with_its_publish_flag_conforms_to_the_published_schema() {
        let event = CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: "r1".to_string(),
            parent_id: Some("c1".to_string()),
            author: "agent".to_string(),
            timestamp: 1,
            kind: EventKind::Reply {
                body: "the wording is already correct".to_string(),
                defense: true,
                published: true,
                run_id: None,
            },
        };
        assert!(valid(&event));
    }

    #[test]
    fn an_address_event_conforms_to_the_published_schema() {
        // Both `started` values (issue #1778: the single-thread path's genuine start vs. a
        // batch's merely-targeted dispatch) are the same event shape on the wire.
        for started in [true, false] {
            let event = CommentEvent {
                schema_version: SCHEMA_VERSION,
                id: "a1".to_string(),
                parent_id: Some("c1".to_string()),
                author: "you".to_string(),
                timestamp: 1,
                kind: EventKind::Address {
                    run_id: "run-1".to_string(),
                    guidance: Some("use the ESV wording instead".to_string()),
                    started,
                },
            };
            assert!(valid(&event));
        }
    }

    #[test]
    fn a_legacy_address_event_with_no_started_field_deserializes_as_started() {
        // Written before issue #1778 added `started` — every such record came from the
        // single-thread path, which always meant "started" (`address_started_default`).
        let json = serde_json::json!({
            "schema_version": SCHEMA_VERSION,
            "id": "a1",
            "parent_id": "c1",
            "author": "you",
            "timestamp": 1,
            "type": "address",
            "run_id": "run-1",
            "guidance": null,
        });
        let event: CommentEvent = serde_json::from_value(json).unwrap();
        assert_eq!(
            event.kind,
            EventKind::Address {
                run_id: "run-1".to_string(),
                guidance: None,
                started: true,
            }
        );
    }

    #[test]
    fn address_stopped_and_address_failed_events_conform_to_the_published_schema() {
        for kind in [
            EventKind::AddressStopped {
                run_id: "run-1".to_string(),
            },
            EventKind::AddressFailed {
                run_id: "run-1".to_string(),
            },
        ] {
            let event = CommentEvent {
                schema_version: SCHEMA_VERSION,
                id: "s1".to_string(),
                parent_id: Some("c1".to_string()),
                author: "you".to_string(),
                timestamp: 2,
                kind,
            };
            assert!(valid(&event));
        }
    }

    #[test]
    fn a_link_changes_event_conforms_to_the_published_schema() {
        let event = CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: "l1".to_string(),
            parent_id: Some("c1".to_string()),
            author: "agent".to_string(),
            timestamp: 2,
            kind: EventKind::LinkChanges {
                change_ids: vec!["chg-1".to_string(), "chg-2".to_string()],
            },
        };
        assert!(valid(&event));
    }

    #[test]
    fn a_decide_linked_change_event_conforms_to_the_published_schema() {
        for decision in [LinkedChangeDecision::Accept, LinkedChangeDecision::Reject] {
            let event = CommentEvent {
                schema_version: SCHEMA_VERSION,
                id: "dec1".to_string(),
                parent_id: Some("c1".to_string()),
                author: "you".to_string(),
                timestamp: 3,
                kind: EventKind::DecideLinkedChange {
                    change_id: "chg-1".to_string(),
                    decision,
                },
            };
            assert!(valid(&event));
        }
    }
}

#[cfg(test)]
mod fold_tests {
    use super::*;

    fn create(id: &str, parent: Option<&str>, author: &str, ts: i64, body: &str) -> CommentEvent {
        CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: parent.map(str::to_string),
            author: author.to_string(),
            timestamp: ts,
            kind: EventKind::Create {
                anchor: None,
                body: body.to_string(),
                severity: None,
                skill: None,
                workflow_run: None,
            },
        }
    }

    fn reply(id: &str, parent: &str, author: &str, ts: i64, body: &str) -> CommentEvent {
        CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: Some(parent.to_string()),
            author: author.to_string(),
            timestamp: ts,
            kind: EventKind::Reply {
                body: body.to_string(),
                defense: false,
                published: false,
                run_id: None,
            },
        }
    }

    fn resolve(id: &str, parent: &str, author: &str, ts: i64) -> CommentEvent {
        CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: Some(parent.to_string()),
            author: author.to_string(),
            timestamp: ts,
            kind: EventKind::Resolve,
        }
    }

    fn reopen(id: &str, parent: &str, author: &str, ts: i64) -> CommentEvent {
        CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: Some(parent.to_string()),
            author: author.to_string(),
            timestamp: ts,
            kind: EventKind::Reopen,
        }
    }

    fn reanchor(
        id: &str,
        parent: &str,
        author: &str,
        ts: i64,
        doc: &textops::Document,
    ) -> CommentEvent {
        CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: Some(parent.to_string()),
            author: author.to_string(),
            timestamp: ts,
            kind: EventKind::ReAnchor {
                anchor: Anchor::new(doc, 0, 3),
            },
        }
    }

    fn unknown(id: &str, parent: Option<&str>, ts: i64) -> CommentEvent {
        CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: parent.map(str::to_string),
            author: "someone".to_string(),
            timestamp: ts,
            kind: EventKind::Unknown,
        }
    }

    fn defense_reply(
        id: &str,
        parent: &str,
        author: &str,
        ts: i64,
        body: &str,
        published: bool,
    ) -> CommentEvent {
        CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: Some(parent.to_string()),
            author: author.to_string(),
            timestamp: ts,
            kind: EventKind::Reply {
                body: body.to_string(),
                defense: true,
                published,
                run_id: None,
            },
        }
    }

    fn address(id: &str, parent: &str, author: &str, ts: i64, run_id: &str) -> CommentEvent {
        address_with_guidance(id, parent, author, ts, run_id, None, true)
    }

    /// The shared `Address` event builder. `started` (issue #1778) is the only thing that
    /// distinguishes the ordinary single-thread path ([`address`]/[`address_with_guidance`]'s own
    /// callers, always `true` — dispatch and start are the same event there) from a batch's own
    /// per-thread dispatch fallback ([`address_targeted`], always `false`: this build has no
    /// per-thread signal to claim start evidence with).
    fn address_with_guidance(
        id: &str,
        parent: &str,
        author: &str,
        ts: i64,
        run_id: &str,
        guidance: Option<&str>,
        started: bool,
    ) -> CommentEvent {
        CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: Some(parent.to_string()),
            author: author.to_string(),
            timestamp: ts,
            kind: EventKind::Address {
                run_id: run_id.to_string(),
                guidance: guidance.map(str::to_string),
                started,
            },
        }
    }

    /// A batch's own per-thread dispatch fallback (issue #1778): targets the thread — sets
    /// `pending_run` — without claiming per-thread start evidence this build cannot observe.
    fn address_targeted(
        id: &str,
        parent: &str,
        author: &str,
        ts: i64,
        run_id: &str,
    ) -> CommentEvent {
        address_with_guidance(id, parent, author, ts, run_id, None, false)
    }

    fn address_stopped(
        id: &str,
        parent: &str,
        author: &str,
        ts: i64,
        run_id: &str,
    ) -> CommentEvent {
        CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: Some(parent.to_string()),
            author: author.to_string(),
            timestamp: ts,
            kind: EventKind::AddressStopped {
                run_id: run_id.to_string(),
            },
        }
    }

    fn address_failed(id: &str, parent: &str, author: &str, ts: i64, run_id: &str) -> CommentEvent {
        CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: Some(parent.to_string()),
            author: author.to_string(),
            timestamp: ts,
            kind: EventKind::AddressFailed {
                run_id: run_id.to_string(),
            },
        }
    }

    fn link_changes(
        id: &str,
        parent: &str,
        author: &str,
        ts: i64,
        change_ids: &[&str],
    ) -> CommentEvent {
        CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: Some(parent.to_string()),
            author: author.to_string(),
            timestamp: ts,
            kind: EventKind::LinkChanges {
                change_ids: change_ids.iter().map(|s| s.to_string()).collect(),
            },
        }
    }

    fn decide(
        id: &str,
        parent: &str,
        author: &str,
        ts: i64,
        change_id: &str,
        decision: LinkedChangeDecision,
    ) -> CommentEvent {
        CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: id.to_string(),
            parent_id: Some(parent.to_string()),
            author: author.to_string(),
            timestamp: ts,
            kind: EventKind::DecideLinkedChange {
                change_id: change_id.to_string(),
                decision,
            },
        }
    }

    // --- basics ----------------------------------------------------------------

    #[test]
    fn a_lone_create_becomes_an_open_unresolved_thread() {
        let state = fold([create("c1", None, "alice", 0, "why here?")]);
        let thread = state.threads.get("c1").unwrap();
        assert_eq!(thread.author, "alice");
        assert_eq!(thread.body, "why here?");
        assert!(!thread.resolved);
        assert!(thread.replies.is_empty());
    }

    #[test]
    fn a_reply_attaches_to_its_thread_in_causal_order() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            reply("r1", "c1", "bob", 1, "good catch"),
        ]);
        let thread = state.threads.get("c1").unwrap();
        assert_eq!(thread.replies.len(), 1);
        assert_eq!(thread.replies[0].author, "bob");
        assert_eq!(thread.replies[0].body, "good catch");
    }

    #[test]
    fn create_carries_severity_skill_and_workflow_run_through_the_fold() {
        // FR-REVIEW-2/D6: review findings land as severity-tagged, skill-attributed
        // comments — these fields must survive the fold, not just round-trip JSON.
        let event = CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: "c1".to_string(),
            parent_id: None,
            author: "biblical-accuracy".to_string(),
            timestamp: 0,
            kind: EventKind::Create {
                anchor: None,
                body: "check this citation".to_string(),
                severity: Some("high".to_string()),
                skill: Some("biblical-accuracy".to_string()),
                workflow_run: Some("run-42".to_string()),
            },
        };
        let state = fold([event]);
        let thread = state.threads.get("c1").unwrap();
        assert_eq!(thread.severity.as_deref(), Some("high"));
        assert_eq!(thread.skill.as_deref(), Some("biblical-accuracy"));
        assert_eq!(thread.workflow_run.as_deref(), Some("run-42"));
    }

    #[test]
    fn a_reply_to_a_reply_resolves_to_the_same_thread() {
        // FR-CMT-4's reply_to_comment addresses any comment id, so nested replies
        // must land in the same thread as their ultimate root.
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            reply("r1", "c1", "bob", 1, "good catch"),
            reply("r2", "r1", "alice", 2, "agreed, fixing"),
        ]);
        let thread = state.threads.get("c1").unwrap();
        assert_eq!(thread.replies.len(), 2);
        assert_eq!(thread.replies[1].body, "agreed, fixing");
    }

    // --- the acceptance chain: create -> reply -> resolve -> reopen -> re-anchor -

    #[test]
    fn the_full_causal_chain_folds_correctly_across_authors_regardless_of_arrival_order() {
        let doc = textops::Document::new("abcdef");
        let events = [
            create("c1", None, "alice", 0, "please clarify"),
            reply("r1", "c1", "bob", 1, "on it"),
            resolve("s1", "c1", "alice", 2),
            reopen("o1", "c1", "bob", 3),
            reanchor("a1", "c1", "alice", 4, &doc),
        ];

        // Adversarial cross-author interleaving: scramble arrival order (as if the
        // events landed from two different authors' JSONL files in whatever order
        // sync happened to deliver them).
        let scrambled = vec![
            events[3].clone(), // reopen
            events[1].clone(), // reply
            events[4].clone(), // re-anchor
            events[0].clone(), // create
            events[2].clone(), // resolve
        ];

        let state = fold(scrambled);
        let thread = state.threads.get("c1").unwrap();
        assert!(
            !thread.resolved,
            "reopen (ts 3) is the last resolve/reopen action"
        );
        assert_eq!(thread.replies.len(), 1);
        assert_eq!(thread.replies[0].author, "bob");
        assert_eq!(thread.anchor.as_ref().unwrap().text_snapshot, "abc");
    }

    // --- clock skew / timestamp ties ---------------------------------------------

    #[test]
    fn a_child_whose_timestamp_precedes_its_parents_due_to_clock_skew_still_applies() {
        // Reply stamped *before* its own thread's create (a different machine's
        // clock ran behind) — sorting by (timestamp, id) alone would process the
        // reply first; buffer-until-parent must still land it on the thread.
        let state = fold([
            reply("r1", "c1", "bob", 0, "premature reply"),
            create("c1", None, "alice", 100, "please clarify"),
        ]);
        let thread = state.threads.get("c1").unwrap();
        assert_eq!(thread.replies.len(), 1);
        assert_eq!(thread.replies[0].body, "premature reply");
    }

    #[test]
    fn identical_timestamps_break_ties_deterministically_by_id() {
        // Two resolve/reopen actions at the exact same millisecond: whichever
        // ordering they arrive in, the fold must apply them in the same
        // (timestamp, id) order every time, not input order.
        let forward = fold([
            create("c1", None, "alice", 0, "x"),
            resolve("s1", "c1", "alice", 5),
            reopen("o1", "c1", "bob", 5),
        ]);
        let backward = fold([
            create("c1", None, "alice", 0, "x"),
            reopen("o1", "c1", "bob", 5),
            resolve("s1", "c1", "alice", 5),
        ]);
        // "o1" < "s1" lexicographically, so at equal timestamps reopen (o1) is
        // always applied before resolve (s1) — final state is resolved regardless
        // of the order these two lines were fed in.
        assert!(forward.threads["c1"].resolved);
        assert!(backward.threads["c1"].resolved);
    }

    // --- dangling references ----------------------------------------------------

    #[test]
    fn a_reply_whose_parent_never_arrives_is_buffered_forever_not_applied_or_lost() {
        let state = fold([reply("r1", "nonexistent", "bob", 0, "orphaned")]);
        assert!(state.threads.is_empty());
        // No panic, no phantom thread — a defined, quiet no-op (P5).
    }

    #[test]
    fn a_dangling_reply_does_not_corrupt_an_unrelated_threads_state() {
        let state = fold([
            reply("r1", "nonexistent", "bob", 0, "orphaned"),
            create("c1", None, "alice", 1, "real thread"),
        ]);
        assert_eq!(state.threads.len(), 1);
        assert!(state.threads.contains_key("c1"));
    }

    // --- unknown event types -----------------------------------------------------

    #[test]
    fn unknown_event_kinds_are_skipped_not_fatal_and_do_not_change_the_fold() {
        let with_unknown = fold([
            create("c1", None, "alice", 0, "x"),
            unknown("u1", Some("c1"), 1),
            reply("r1", "c1", "bob", 2, "y"),
        ]);
        let without_unknown = fold([
            create("c1", None, "alice", 0, "x"),
            reply("r1", "c1", "bob", 2, "y"),
        ]);
        assert_eq!(with_unknown.threads, without_unknown.threads);
    }

    #[test]
    fn nothing_can_ever_target_an_unknown_event_as_a_parent() {
        // An Unknown event never registers in id_to_thread, so a legitimate event
        // that names it as parent_id buffers forever (same as any other dangling
        // reference) rather than panicking or silently attaching to the wrong thread.
        let state = fold([
            unknown("u1", None, 0),
            reply("r1", "u1", "bob", 1, "targets the unknown event"),
        ]);
        assert!(state.threads.is_empty());
    }

    // --- incremental-sync invariant ---------------------------------------------

    #[test]
    fn folding_a_prefix_then_the_rest_matches_folding_everything_at_once() {
        let doc = textops::Document::new("abcdef");
        let all = vec![
            create("c1", None, "alice", 0, "please clarify"),
            reply("r1", "c1", "bob", 1, "on it"),
            resolve("s1", "c1", "alice", 2),
            reopen("o1", "c1", "bob", 3),
            reanchor("a1", "c1", "alice", 4, &doc),
        ];

        let mut incremental = Fold::new();
        incremental.apply(all[..2].to_vec());
        incremental.apply(all[2..].to_vec());

        let direct = fold(all);

        assert_eq!(incremental.threads, direct.threads);
    }

    #[test]
    fn equal_time_delivery_sorted_before_resolve_cannot_close_undecided_work() {
        let state = fold([
            create("c1", None, "alice", 0, "please revise"),
            address("a1", "c1", "alice", 1, "run-1"),
            resolve("r1", "c1", "alice", 3),
            link_changes("l1", "a1", "agent", 3, &["change-1"]),
        ]);
        let thread = &state.threads["c1"];
        assert!(!thread.resolved);
        assert_eq!(thread.linked_changes.len(), 1);
        assert!(thread.linked_changes[0].decision.is_none());
    }

    #[test]
    fn manual_resolve_and_delivery_stay_open_under_other_tie_and_skew_orders() {
        for (delivery_id, delivery_time) in [("z1", 3), ("l1", 2), ("z1", 4)] {
            let state = fold([
                create("c1", None, "alice", 0, "please revise"),
                address("a1", "c1", "alice", 1, "run-1"),
                resolve("r1", "c1", "alice", 3),
                link_changes(delivery_id, "a1", "agent", delivery_time, &["change-1"]),
            ]);
            let thread = &state.threads["c1"];
            assert!(
                !thread.resolved,
                "delivery {delivery_id} at {delivery_time} must leave an undecided thread open"
            );
            assert_eq!(thread.linked_changes.len(), 1);
            assert!(thread.linked_changes[0].decision.is_none());
        }
    }

    // --- address with AI: pending / delivery / decide (FR-CMT-2/3/4/7) -----------

    #[test]
    fn addressing_a_thread_marks_it_pending_with_the_run_id() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "you", 1, "run-1"),
        ]);
        let thread = &state.threads["c1"];
        assert_eq!(thread.pending_run.as_deref(), Some("run-1"));
        assert!(thread.pending_guidance.is_none());
        // The single-thread path's dispatch *is* its start (issue #1778) — unlike a batch's own
        // targeting event below, this one claims Working from the moment it lands.
        assert!(thread.pending_run_started);
    }

    #[test]
    fn target_history_survives_delivery_and_multiple_address_runs() {
        let state = fold(vec![
            create("c1", None, "alice", 0, "question"),
            address("a1", "c1", "alice", 1, "run-a"),
            defense_reply("d1", "c1", "agent", 2, "explained", false),
            address("a2", "c1", "alice", 3, "run-b"),
        ]);
        let thread = &state.threads["c1"];
        assert_eq!(thread.pending_run.as_deref(), Some("run-b"));
        assert!(thread.targeting_run_ids.contains("run-a"));
        assert!(thread.targeting_run_ids.contains("run-b"));
    }

    #[test]
    fn correction_suppresses_a_late_conclusion_note_without_erasing_pending_attribution() {
        for correction_kind in [
            EventKind::Revise {
                body: "corrected".into(),
            },
            EventKind::Withdraw,
        ] {
            for failed in [false, true] {
                let correction = CommentEvent {
                    schema_version: SCHEMA_VERSION,
                    id: "fix".into(),
                    parent_id: Some("c1".into()),
                    author: "alice".into(),
                    timestamp: 2,
                    kind: correction_kind.clone(),
                };
                let conclusion = if failed {
                    address_failed("s1", "c1", "alice", 3, "run-a")
                } else {
                    address_stopped("s1", "c1", "alice", 3, "run-a")
                };
                let late_conclusion = fold(vec![
                    create("c1", None, "alice", 0, "original"),
                    address("a1", "c1", "alice", 1, "run-a"),
                    correction.clone(),
                    conclusion.clone(),
                ]);
                let thread = &late_conclusion.threads["c1"];
                assert!(thread.pending_run.is_none());
                assert!(
                    thread.concluded_run.is_none(),
                    "late conclusion follows the user's correction"
                );

                let conclusion_first = fold(vec![
                    create("c1", None, "alice", 0, "original"),
                    address("a1", "c1", "alice", 1, "run-a"),
                    CommentEvent {
                        timestamp: 2,
                        ..conclusion
                    },
                    CommentEvent {
                        timestamp: 3,
                        ..correction
                    },
                ]);
                assert!(conclusion_first.threads["c1"].concluded_run.is_none());
            }
        }
    }

    #[test]
    fn an_offline_correction_does_not_erase_a_live_address_runs_delivery_attribution() {
        let corrected = CommentEvent {
            schema_version: SCHEMA_VERSION,
            id: "fix".into(),
            parent_id: Some("c1".into()),
            author: "alice".into(),
            timestamp: 2,
            kind: EventKind::Revise {
                body: "edited offline".into(),
            },
        };
        let state = fold(vec![
            create("c1", None, "alice", 0, "original"),
            address("a1", "c1", "alice", 1, "run-a"),
            corrected,
            link_changes("l1", "a1", "agent", 3, &["change-1"]),
        ]);
        assert_eq!(
            state.threads["c1"].linked_changes[0].run_id.as_deref(),
            Some("run-a")
        );
    }

    // --- targeted vs. started (issue #1778, ux-design.md §2 "Batch … Working means started, not
    // targeted", UXR-Q10/#1122): a batch's own per-thread dispatch must not claim per-thread start
    // evidence it cannot observe. -----------------------------------------------------------------

    #[test]
    fn a_batch_targeted_address_leaves_pending_run_set_but_not_started() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address_targeted("a1", "c1", "you", 1, "batch-1"),
        ]);
        let thread = &state.threads["c1"];
        assert_eq!(
            thread.pending_run.as_deref(),
            Some("batch-1"),
            "the thread is still targeted, for eligibility/attribution purposes"
        );
        assert!(
            !thread.pending_run_started,
            "targeting alone is not per-thread start evidence"
        );
    }

    #[test]
    fn two_address_runs_keep_independent_pending_identity() {
        let events = vec![
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "you", 1, "run-1"),
            address_targeted("a2", "c1", "you", 2, "batch-2"),
        ];
        let both = fold(events.clone());
        let thread = &both.threads["c1"];
        assert_eq!(thread.pending_addresses.len(), 2);
        assert_eq!(thread.pending_addresses[0].event_id, "a1");
        assert_eq!(thread.pending_addresses[1].event_id, "a2");
        assert!(
            thread.pending_run.is_none(),
            "P5 order cannot establish queue order"
        );
        assert!(!thread.pending_run_started);

        let after_first_stops = fold(
            events
                .into_iter()
                .chain([address_stopped("stop-1", "c1", "you", 3, "run-1")]),
        );
        let thread = &after_first_stops.threads["c1"];
        assert_eq!(thread.pending_addresses.len(), 1);
        assert_eq!(thread.pending_addresses[0].run_id, "batch-2");
        assert_eq!(thread.pending_run.as_deref(), Some("batch-2"));
        assert!(!thread.pending_run_started);
    }

    #[test]
    fn a_batch_target_retains_prior_started_status_without_projecting_either_run() {
        // J4 permits a deliberate queued batch target beside an earlier run. The fold retains
        // each started fact, but cannot infer queue order from P5's sorted event timestamps.
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "you", 1, "run-1"),
            address_targeted("a2", "c1", "you", 2, "batch-2"),
        ]);
        let thread = &state.threads["c1"];
        assert!(thread.pending_run.is_none());
        assert!(!thread.pending_run_started);
        assert!(thread.pending_addresses[0].started);
        assert_eq!(thread.pending_addresses[1].run_id, "batch-2");
        assert!(!thread.pending_addresses[1].started);
    }

    #[test]
    fn a_defense_reply_clears_pending_run_started_alongside_pending_run() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "you", 1, "run-1"),
            defense_reply("r1", "c1", "agent", 2, "no change needed", false),
        ]);
        let thread = &state.threads["c1"];
        assert!(thread.pending_run.is_none());
        assert!(!thread.pending_run_started);
    }

    #[test]
    fn a_defense_names_only_its_pending_run() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "you", 1, "run-1"),
            address_targeted("a2", "c1", "you", 2, "batch-2"),
            CommentEvent {
                schema_version: SCHEMA_VERSION,
                id: "defense-1".into(),
                parent_id: Some("c1".into()),
                author: "agent".into(),
                timestamp: 3,
                kind: EventKind::Reply {
                    body: "The wording is correct.".into(),
                    defense: true,
                    published: false,
                    run_id: Some("run-1".into()),
                },
            },
        ]);
        let thread = &state.threads["c1"];
        assert_eq!(thread.pending_addresses.len(), 1);
        assert_eq!(thread.pending_addresses[0].run_id, "batch-2");
        assert_eq!(thread.replies[0].parent_id, "c1");
    }

    #[test]
    fn skewed_explicit_defense_concludes_its_later_sorted_address() {
        let mut defense = defense_reply("d1", "c1", "agent", 1, "No change", false);
        if let EventKind::Reply { run_id, .. } = &mut defense.kind {
            *run_id = Some("run-1".into());
        }
        let thread = &fold([
            create("c1", None, "alice", 0, "why?"),
            defense,
            address("a1", "c1", "you", 2, "run-1"),
        ])
        .threads["c1"];
        assert!(thread.pending_addresses.is_empty());
        assert_eq!(thread.replies.len(), 1);
        assert_eq!(thread.replies[0].parent_id, "c1");
    }

    #[test]
    fn tied_id_ordered_stop_and_failure_conclude_their_later_addresses() {
        for (terminal, expected) in [
            (
                address_stopped("a-stop", "c1", "you", 1, "run-1"),
                RunConclusion::Stopped,
            ),
            (
                address_failed("a-fail", "c1", "you", 1, "run-1"),
                RunConclusion::Failed,
            ),
        ] {
            let thread = &fold([
                create("c1", None, "alice", 0, "why?"),
                terminal,
                address("z-address", "c1", "you", 1, "run-1"),
            ])
            .threads["c1"];
            assert!(thread.pending_addresses.is_empty());
            assert_eq!(
                thread.concluded_run.as_ref().map(|note| note.outcome),
                Some(expected)
            );
        }
    }

    #[test]
    fn linking_changes_clears_pending_and_starts_every_change_undecided() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "you", 1, "run-1"),
            link_changes("l1", "c1", "agent", 2, &["chg-1", "chg-2"]),
        ]);
        let thread = &state.threads["c1"];
        assert!(thread.pending_run.is_none());
        assert_eq!(thread.linked_changes.len(), 2);
        assert!(thread.linked_changes.iter().all(|c| c.decision.is_none()));
    }

    // --- delivery attribution (#1380: the provenance ux-design.md §2 needs) -------------------

    #[test]
    fn a_delivered_change_is_attributed_to_the_run_and_link_changes_event_that_produced_it() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "you", 1, "run-1"),
            link_changes("l1", "c1", "agent", 2, &["chg-1", "chg-2"]),
        ]);
        let thread = &state.threads["c1"];
        for change in &thread.linked_changes {
            assert_eq!(change.run_id.as_deref(), Some("run-1"));
            assert_eq!(change.delivery_id, "l1");
            assert_eq!(change.delivered_at, 2);
        }
    }

    #[test]
    fn a_late_delivery_keeps_its_causal_run_after_stop() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "you", 1, "run-1"),
            address_targeted("a2", "c1", "you", 2, "batch-2"),
            address_stopped("stop-1", "c1", "you", 3, "run-1"),
            link_changes("delivery-1", "a1", "agent", 4, &["chg-1"]),
        ]);
        let thread = &state.threads["c1"];
        assert_eq!(thread.linked_changes[0].run_id.as_deref(), Some("run-1"));
        assert_eq!(thread.pending_addresses.len(), 1);
        assert_eq!(thread.pending_addresses[0].run_id, "batch-2");
    }

    #[test]
    fn a_clock_skewed_delivery_causally_parented_to_its_address_clears_and_names_that_run() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("z-address", "c1", "you", 3_000, "run-skew"),
            link_changes("a-link", "z-address", "agent", 2_000, &["chg-1"]),
        ]);
        let thread = &state.threads["c1"];
        assert_eq!(
            (
                thread.pending_run.as_deref(),
                thread.linked_changes[0].run_id.as_deref()
            ),
            (None, Some("run-skew")),
        );
    }

    #[test]
    fn an_equal_timestamp_delivery_sorting_before_its_address_still_clears_and_names_that_run() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("z-address", "c1", "you", 2_000, "run-tie"),
            link_changes("a-link", "z-address", "agent", 2_000, &["chg-1"]),
        ]);
        let thread = &state.threads["c1"];
        assert_eq!(
            (
                thread.pending_run.as_deref(),
                thread.linked_changes[0].run_id.as_deref()
            ),
            (None, Some("run-tie")),
        );
    }

    #[test]
    fn a_delivery_with_no_preceding_address_is_attributed_to_no_run_rather_than_panicking() {
        // Not expected from a conforming writer (`link_changes` always follows its own `address`),
        // but the fold tolerates it — same "no matching target: skip" spirit as the rest of this
        // module — rather than asserting the writer's contract with a panic.
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            link_changes("l1", "c1", "agent", 1, &["chg-1"]),
        ]);
        let change = &state.threads["c1"].linked_changes[0];
        assert_eq!(change.run_id, None);
        assert_eq!(change.delivery_id, "l1");
    }

    #[test]
    fn re_delegated_deliveries_carry_distinct_attribution_even_though_they_share_one_thread() {
        // FR-CMT-7: a twice-re-delegated thread can carry undecided changes from more than one
        // delivery — each must name its *own* run and delivery, never collapse onto the other's
        // (ux-design.md §2: "each is listed under its own").
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "you", 1, "run-1"),
            link_changes("l1", "c1", "agent", 2, &["chg-1"]),
            decide(
                "dec1",
                "c1",
                "you",
                3,
                "chg-1",
                LinkedChangeDecision::Reject,
            ),
            address("a2", "c1", "you", 4, "run-2"),
            link_changes("l2", "c1", "agent", 5, &["chg-2"]),
        ]);
        let thread = &state.threads["c1"];
        let first = thread
            .linked_changes
            .iter()
            .find(|c| c.change_id == "chg-1")
            .unwrap();
        let second = thread
            .linked_changes
            .iter()
            .find(|c| c.change_id == "chg-2")
            .unwrap();
        assert_eq!(first.run_id.as_deref(), Some("run-1"));
        assert_eq!(first.delivery_id, "l1");
        assert_eq!(first.delivered_at, 2);
        assert_eq!(second.run_id.as_deref(), Some("run-2"));
        assert_eq!(second.delivery_id, "l2");
        assert_eq!(second.delivered_at, 5);
        assert_ne!(first.delivery_id, second.delivery_id);
    }

    #[test]
    fn a_defense_reply_clears_pending_without_linking_any_change() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "you", 1, "run-1"),
            defense_reply(
                "d1",
                "c1",
                "agent",
                2,
                "the wording is already correct",
                false,
            ),
        ]);
        let thread = &state.threads["c1"];
        assert!(thread.pending_run.is_none());
        assert!(thread.linked_changes.is_empty());
        assert!(thread.replies[0].defense);
        assert!(!thread.replies[0].published);
        assert!(
            !thread.resolved,
            "a defense never resolves the thread on its own"
        );
    }

    #[test]
    fn a_defense_replys_publish_flag_round_trips() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            defense_reply("d1", "c1", "agent", 1, "correct as written", true),
        ]);
        assert!(state.threads["c1"].replies[0].published);
    }

    #[test]
    fn accepting_the_single_linked_change_resolves_the_thread() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            link_changes("l1", "c1", "agent", 1, &["chg-1"]),
            decide(
                "dec1",
                "c1",
                "you",
                2,
                "chg-1",
                LinkedChangeDecision::Accept,
            ),
        ]);
        assert!(state.threads["c1"].resolved);
    }

    #[test]
    fn rejecting_the_single_linked_change_reopens_not_resolves() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            link_changes("l1", "c1", "agent", 1, &["chg-1"]),
            decide(
                "dec1",
                "c1",
                "you",
                2,
                "chg-1",
                LinkedChangeDecision::Reject,
            ),
        ]);
        assert!(!state.threads["c1"].resolved);
    }

    #[test]
    fn a_multi_change_fix_does_not_resolve_until_every_change_is_decided() {
        // FR-CMT-7: two linked changes, only one decided (accepted) — not resolved yet.
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            link_changes("l1", "c1", "agent", 1, &["chg-1", "chg-2"]),
            decide(
                "dec1",
                "c1",
                "you",
                2,
                "chg-1",
                LinkedChangeDecision::Accept,
            ),
        ]);
        assert!(!state.threads["c1"].resolved);
    }

    #[test]
    fn a_multi_change_fix_resolves_once_all_decided_with_at_least_one_accepted() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            link_changes("l1", "c1", "agent", 1, &["chg-1", "chg-2"]),
            decide(
                "dec1",
                "c1",
                "you",
                2,
                "chg-1",
                LinkedChangeDecision::Reject,
            ),
            decide(
                "dec2",
                "c1",
                "you",
                3,
                "chg-2",
                LinkedChangeDecision::Accept,
            ),
        ]);
        assert!(
            state.threads["c1"].resolved,
            "all decided and one accepted must resolve even though the other was rejected"
        );
    }

    #[test]
    fn a_multi_change_fix_stays_unresolved_when_every_decided_change_is_rejected() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            link_changes("l1", "c1", "agent", 1, &["chg-1", "chg-2"]),
            decide(
                "dec1",
                "c1",
                "you",
                2,
                "chg-1",
                LinkedChangeDecision::Reject,
            ),
            decide(
                "dec2",
                "c1",
                "you",
                3,
                "chg-2",
                LinkedChangeDecision::Reject,
            ),
        ]);
        assert!(!state.threads["c1"].resolved);
    }

    #[test]
    fn deciding_a_change_id_this_thread_never_linked_is_a_quiet_no_op() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            link_changes("l1", "c1", "agent", 1, &["chg-1"]),
            decide(
                "dec1",
                "c1",
                "you",
                2,
                "chg-unrelated",
                LinkedChangeDecision::Accept,
            ),
        ]);
        let thread = &state.threads["c1"];
        assert!(!thread.resolved);
        assert_eq!(thread.linked_changes[0].decision, None);
    }

    #[test]
    fn a_reopen_guided_re_delegation_records_the_note_while_pending() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            link_changes("l1", "c1", "agent", 1, &["chg-1"]),
            decide(
                "dec1",
                "c1",
                "you",
                2,
                "chg-1",
                LinkedChangeDecision::Reject,
            ),
            address_with_guidance(
                "a2",
                "c1",
                "you",
                3,
                "run-2",
                Some("use the ESV wording instead"),
                true,
            ),
        ]);
        let thread = &state.threads["c1"];
        assert_eq!(thread.pending_run.as_deref(), Some("run-2"));
        assert_eq!(
            thread.pending_guidance.as_deref(),
            Some("use the ESV wording instead")
        );
    }

    #[test]
    fn re_delegation_accumulates_linked_changes_across_rounds_rather_than_replacing_them() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            link_changes("l1", "c1", "agent", 1, &["chg-1"]),
            decide(
                "dec1",
                "c1",
                "you",
                2,
                "chg-1",
                LinkedChangeDecision::Reject,
            ),
            address("a2", "c1", "you", 3, "run-2"),
            link_changes("l2", "c1", "agent", 4, &["chg-2"]),
        ]);
        let ids: Vec<&str> = state.threads["c1"]
            .linked_changes
            .iter()
            .map(|c| c.change_id.as_str())
            .collect();
        assert_eq!(ids, vec!["chg-1", "chg-2"]);
    }

    // --- address run conclusion without delivery: stop/fail (issue #1381) --------

    #[test]
    fn a_stopped_run_clears_the_pending_marker_and_records_the_stopped_note() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "you", 1, "run-1"),
            address_stopped("s1", "c1", "you", 2, "run-1"),
        ]);
        let thread = &state.threads["c1"];
        assert!(thread.pending_run.is_none());
        assert!(thread.pending_guidance.is_none());
        assert_eq!(
            thread.concluded_run,
            Some(ConcludedRun {
                run_id: "run-1".to_string(),
                outcome: RunConclusion::Stopped,
            })
        );
    }

    #[test]
    fn a_failed_run_clears_the_pending_marker_and_records_the_failed_note() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "you", 1, "run-1"),
            address_failed("f1", "c1", "you", 2, "run-1"),
        ]);
        let thread = &state.threads["c1"];
        assert!(thread.pending_run.is_none());
        assert_eq!(
            thread.concluded_run,
            Some(ConcludedRun {
                run_id: "run-1".to_string(),
                outcome: RunConclusion::Failed,
            })
        );
    }

    /// The guard this card exists to protect: a stop/failure event naming a run this thread has
    /// already moved past (a re-delegation minted a new run id before the old run's own conclusion
    /// event arrived — clock skew or plain out-of-order delivery, same as any other cross-author
    /// event) must not clear the *new* run's pending state, and must not overwrite it with a note
    /// about the *old* one.
    #[test]
    fn a_stale_conclusion_for_a_superseded_run_is_a_no_op() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "you", 1, "run-1"),
            address("a2", "c1", "you", 2, "run-2"), // re-delegated before run-1's own stop arrived
            address_stopped("s1", "c1", "you", 3, "run-1"),
        ]);
        let thread = &state.threads["c1"];
        assert_eq!(
            thread.pending_run.as_deref(),
            Some("run-2"),
            "the stale stop for run-1 must not touch run-2's still-live pending state"
        );
        assert!(
            thread.concluded_run.is_none(),
            "no note is owed for a run this thread never actually saw conclude"
        );
    }

    /// The mirror case: a *live* run's conclusion event racing ahead of causal order (unlikely
    /// under real clocks, but the fold defines total order over `(timestamp, id)`, not arrival) does
    /// still clear it when the id genuinely matches.
    #[test]
    fn a_matching_conclusion_clears_the_run_it_actually_names_even_after_a_later_redelegation_address_event(
    ) {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "you", 1, "run-1"),
            address_stopped("s1", "c1", "you", 2, "run-1"),
            address("a2", "c1", "you", 3, "run-2"),
        ]);
        let thread = &state.threads["c1"];
        assert_eq!(thread.pending_run.as_deref(), Some("run-2"));
    }

    /// The exit table's "persistent until the user's next action on the thread" rule: every other
    /// event kind reaching the thread afterwards clears the note, one representative per kind.
    #[test]
    fn the_concluded_run_note_is_cleared_by_the_threads_next_action_of_any_kind() {
        for clearing_event in [
            reply("r1", "c1", "you", 2, "ok"),
            resolve("s1", "c1", "you", 2),
            reanchor("a1", "c1", "you", 2, &textops::Document::new("Hello world")),
            address("a2", "c1", "you", 2, "run-2"),
        ] {
            let state = fold([
                create("c1", None, "alice", 0, "why here?"),
                address("a1", "c1", "you", 1, "run-1"),
                address_stopped("s1", "c1", "you", 1, "run-1"),
                clearing_event,
            ]);
            assert!(
                state.threads["c1"].concluded_run.is_none(),
                "the note must not survive the thread's next event"
            );
        }
    }

    #[test]
    fn a_link_changes_delivery_after_an_earlier_stop_note_clears_it() {
        // Re-delegating after a stop and then actually delivering must not leave the stale note
        // beside a fresh, successful delivery.
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "you", 1, "run-1"),
            address_stopped("s1", "c1", "you", 2, "run-1"),
            address("a2", "c1", "you", 3, "run-2"),
            link_changes("l1", "c1", "agent", 4, &["chg-1"]),
        ]);
        assert!(state.threads["c1"].concluded_run.is_none());
    }

    #[test]
    fn a_decide_linked_change_after_a_stop_note_from_an_earlier_round_clears_it() {
        let state = fold([
            create("c1", None, "alice", 0, "why here?"),
            link_changes("l1", "c1", "agent", 1, &["chg-1"]),
            decide(
                "dec1",
                "c1",
                "you",
                2,
                "chg-1",
                LinkedChangeDecision::Reject,
            ),
            address("a2", "c1", "you", 3, "run-2"),
            address_stopped("s1", "c1", "you", 4, "run-2"),
            link_changes("l2", "c1", "agent", 5, &["chg-2"]),
            decide(
                "dec2",
                "c1",
                "you",
                6,
                "chg-2",
                LinkedChangeDecision::Accept,
            ),
        ]);
        assert!(state.threads["c1"].concluded_run.is_none());
    }

    #[test]
    fn cross_author_scrambled_address_delivery_and_decision_still_fold_deterministically() {
        // Same adversarial-interleaving shape as the existing full-chain test, exercised over the
        // new address/link/decide events.
        let events = [
            create("c1", None, "alice", 0, "why here?"),
            address("a1", "c1", "alice", 1, "run-1"),
            link_changes("l1", "c1", "agent", 2, &["chg-1", "chg-2"]),
            decide(
                "dec1",
                "c1",
                "you",
                3,
                "chg-1",
                LinkedChangeDecision::Accept,
            ),
            decide(
                "dec2",
                "c1",
                "you",
                4,
                "chg-2",
                LinkedChangeDecision::Accept,
            ),
        ];
        let scrambled = vec![
            events[3].clone(),
            events[1].clone(),
            events[4].clone(),
            events[0].clone(),
            events[2].clone(),
        ];
        let state = fold(scrambled);
        let thread = &state.threads["c1"];
        assert!(thread.pending_run.is_none());
        assert!(thread.resolved);
        assert_eq!(thread.linked_changes.len(), 2);
    }
}

#[cfg(test)]
mod fold_properties {
    use super::*;
    use proptest::prelude::*;

    /// A small, adversarial event universe: arbitrary small timestamps (so ties and
    /// clock skew are common), a mix of kinds including `Unknown`, and parent
    /// references drawn from a range wider than the batch itself (so plenty of
    /// dangling — never-created — references are generated too). Each event's own
    /// `id` is its position in the generated batch (`to_events` assigns it), which
    /// keeps ids unique — the module's real precondition (TD-4: the writer mints a
    /// unique id) — while still letting many events target the same parent.
    #[derive(Clone, Debug)]
    enum Kind {
        Create,
        Reply,
        Publish,
        Resolve,
        Reopen,
        Unknown,
    }

    fn kind_strategy() -> impl Strategy<Value = Kind> {
        prop_oneof![
            Just(Kind::Create),
            Just(Kind::Reply),
            Just(Kind::Publish),
            Just(Kind::Resolve),
            Just(Kind::Reopen),
            Just(Kind::Unknown),
        ]
    }

    fn event_strategy() -> impl Strategy<Value = (Kind, Option<usize>, i64, usize)> {
        (
            kind_strategy(),
            prop::option::of(0usize..16), // parent index; may exceed the batch length (dangling)
            0i64..4,                      // timestamp (small range: forces ties + skew)
            0usize..3,                    // author index
        )
    }

    /// Assigns each generated event a unique id (`"e{position}"`) and turns a
    /// parent index into a reference to that same id space — which may or may not
    /// name an event that actually exists in this batch.
    fn to_events(raw: Vec<(Kind, Option<usize>, i64, usize)>) -> Vec<CommentEvent> {
        raw.into_iter()
            .enumerate()
            .map(|(idx, (kind, parent_idx, ts, author_idx))| {
                let event_kind = match kind {
                    Kind::Create => EventKind::Create {
                        anchor: None,
                        body: "body".to_string(),
                        severity: None,
                        skill: None,
                        workflow_run: None,
                    },
                    Kind::Reply => EventKind::Reply {
                        body: "reply".to_string(),
                        defense: false,
                        published: false,
                        run_id: None,
                    },
                    Kind::Publish => EventKind::Publish,
                    Kind::Resolve => EventKind::Resolve,
                    Kind::Reopen => EventKind::Reopen,
                    Kind::Unknown => EventKind::Unknown,
                };
                // Create never carries a parent_id (module contract).
                let parent_id = if matches!(event_kind, EventKind::Create { .. }) {
                    None
                } else {
                    parent_idx.map(|p| format!("e{p}"))
                };
                CommentEvent {
                    schema_version: SCHEMA_VERSION,
                    id: format!("e{idx}"),
                    parent_id,
                    author: format!("author{author_idx}"),
                    timestamp: ts,
                    kind: event_kind,
                }
            })
            .collect()
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(512))]

        // fold never panics on arbitrary (including malformed/dangling/cyclic-ish)
        // input — the whole point of buffer-until-parent + unknown-skip is that
        // there is no input shape that crashes the fold.
        #[test]
        fn prop_fold_never_panics_on_arbitrary_events(raw in prop::collection::vec(event_strategy(), 0..16)) {
            let events = to_events(raw);
            let _ = fold(events);
        }

        // Determinism: whatever order a fixed multiset of events arrives in, the
        // folded result is identical. This is the real content of "cross-author
        // interleaving doesn't matter" — the fold's causal ordering comes from
        // (timestamp, id), never from input order.
        #[test]
        fn prop_fold_is_independent_of_input_order(
            raw in prop::collection::vec(event_strategy(), 0..12),
            seed in 0u64..10_000,
        ) {
            let events = to_events(raw);
            let original = fold(events.clone()).threads;

            // Deterministic shuffle keyed on `seed` (no external RNG dependency).
            let mut shuffled = events.clone();
            let len = shuffled.len();
            if len > 1 {
                for i in (1..len).rev() {
                    let j = ((seed as usize).wrapping_add(i * 2654435761)) % (i + 1);
                    shuffled.swap(i, j);
                }
            }
            let reordered = fold(shuffled).threads;
            prop_assert_eq!(original, reordered);
        }

        // Incremental-sync invariant (P5): folding a prefix, then continuing with
        // the rest, always equals folding everything in one shot — regardless of
        // where the split falls.
        #[test]
        fn prop_incremental_fold_matches_one_shot_fold(
            raw in prop::collection::vec(event_strategy(), 0..12),
            split_seed in 0usize..13,
        ) {
            let events = to_events(raw);
            let split = if events.is_empty() { 0 } else { split_seed % (events.len() + 1) };
            let (prefix, rest) = events.split_at(split);

            let mut incremental = Fold::new();
            incremental.apply(prefix.to_vec());
            incremental.apply(rest.to_vec());

            let direct = fold(events.clone());
            prop_assert_eq!(incremental.threads, direct.threads);
        }

        // Unknown events are true no-ops: removing them from the input entirely
        // never changes the folded result (they can never be applied, and nothing
        // can ever successfully target one as a parent).
        #[test]
        fn prop_unknown_events_never_affect_the_fold(raw in prop::collection::vec(event_strategy(), 0..12)) {
            let events = to_events(raw);
            let with_unknowns = fold(events.clone()).threads;
            let without_unknowns: Vec<CommentEvent> = events
                .into_iter()
                .filter(|e| !matches!(e.kind, EventKind::Unknown))
                .collect();
            let stripped = fold(without_unknowns).threads;
            prop_assert_eq!(with_unknowns, stripped);
        }
    }
}
