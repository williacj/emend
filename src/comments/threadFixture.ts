// ABOUTME: Shared test fixture for a `CommentThread` — an open, unanchored, human-authored thread
// ABOUTME: whose fields each test overrides only where the behavior under test actually depends.
import type { CommentThread, LinkedChange } from "./types";

/**
 * A minimal open thread. Every field is spelled out rather than defaulted in the type, so a new
 * `CommentThread` field fails this fixture's build and forces each test to say what it wants —
 * which is the point of pinning defaults in one place rather than three.
 *
 * `pending_run_started` (issue #1778) defaults to `false` like every other field here, deliberately
 * *not* derived from `overrides.pending_run`: deriving it would re-encode the pre-#1778 assumption
 * that targeting a thread means working it — the exact defect that issue removes — as this
 * fixture's silent default, so a test later written as `thread({ pending_run: "batch-1" })` would
 * get a Working thread it never asked for. A test that wants Working says
 * `pending_run_started: true` alongside `pending_run`; one that wants a batch target says nothing.
 *
 * Not exported from `comments/index.ts`: this is test scaffolding, not module surface.
 */
export function thread(id: string, overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id,
    author: "alice",
    last_activity_at: 0,
    anchor: null,
    body: `finding ${id}`,
    edited_at: null,
    withdrawn_at: null,
    published: false,
    visible_when_withdrawn: false,
    targeting_run_ids: [],
    resolved: false,
    orphaned: false,
    reopened: false,
    replies: [],
    severity: null,
    skill: null,
    workflow_run: null,
    pending_run: null,
    pending_runs: [],
    pending_run_started: false,
    pending_guidance: null,
    concluded_run: null,
    linked_changes: [],
    ...overrides,
  };
}

/**
 * A minimal delivered `LinkedChange` (#1380: `run_id`/`delivery_id`/`delivered_at` attribute it to
 * the delivery that produced it). Defaults every attribution field to a single delivery ("d1" /
 * "run-1", `delivered_at: 0`) so a test that doesn't care which delivery a change belongs to
 * doesn't have to spell that out — a test proving *grouping* passes distinct `delivery_id`s (and
 * usually `run_id`s) across the changes it builds.
 */
export function linkedChange(changeId: string, overrides: Partial<LinkedChange> = {}): LinkedChange {
  return {
    change_id: changeId,
    decision: null,
    delivery_id: "d1",
    run_id: "run-1",
    delivered_at: 0,
    ...overrides,
  };
}
