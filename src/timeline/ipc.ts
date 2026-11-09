// ABOUTME: Thin IPC bridge to the backend's `commands::transcript` module (P2a-17, D15) — persists
// ABOUTME: rendered timeline cards to the per-project local transcript store and rehydrates them.
// ABOUTME: Outside a Tauri webview (dev-mode e2e per D23, tech-design §3.7) the same calls reach
// ABOUTME: the headless test driver's loopback HTTP surface instead — same commands, no mocking.
import { callBackend } from "../backend";
import type { TimelineCard } from "./types";

/** Mirrors Rust `commands::transcript::CommandError` (`#[serde(tag = "kind", content = "message")]`). */
export interface CommandError {
  kind: "Config" | "Io";
  message: string;
}

/**
 * The wire shape of one persisted event — mirrors Rust `store::transcript::TranscriptEvent`
 * (cross-boundary types are defined in Rust with `Serialize` and mirrored here per CLAUDE.md):
 * the envelope every `TimelineCard` shares, plus whatever kind-specific fields it carries
 * (`author`/`body` for `chat-message`, …), flattened onto the same JSON object.
 */
type TranscriptEventWire = TimelineCard & { schema_version: number };

const SCHEMA_VERSION = 1;

/**
 * Persists `card` to `root`'s local transcript store (D15: durable but local — never
 * repo-synced, never provider session state, TD-5 is a separate mechanism).
 */
export async function appendTranscriptEvent(root: string, card: TimelineCard): Promise<void> {
  const event: TranscriptEventWire = { schema_version: SCHEMA_VERSION, ...card };
  await callBackend<void>("append_transcript_event", { root, event });
}

/**
 * Loads `root`'s persisted transcript, in original append order — the history `TimelinePanel`
 * seeds `initialCards` with on project reopen.
 */
export async function loadTranscript(root: string): Promise<TimelineCard[]> {
  const events = await callBackend<TranscriptEventWire[]>("load_transcript", { root });
  return rekeyRepeatedIds(
    events.map(stripSchemaVersion).filter(isNotProjectGroundingCard).map(tolerateLegacyChangeIds).map(tolerateLegacyCommentRevision),
  );
}

/** D15 transcript cards are local snapshots, so pre-J10 comments need the new correction fields
 * supplied at read time. The append-only transcript remains untouched. */
function tolerateLegacyCommentRevision(card: TimelineCard): TimelineCard {
  if (card.kind !== "comment") return card;
  const thread = card.thread;
  return {
    ...card,
    thread: {
      ...thread,
      edited_at: thread.edited_at ?? null,
      withdrawn_at: thread.withdrawn_at ?? null,
      published: thread.published ?? false,
      visible_when_withdrawn: thread.visible_when_withdrawn ?? false,
      targeting_run_ids: thread.targeting_run_ids ?? [],
      replies: thread.replies.map((reply) => ({
        ...reply,
        parent_id: reply.parent_id ?? thread.id,
        edited_at: reply.edited_at ?? null,
        withdrawn_at: reply.withdrawn_at ?? null,
        published: reply.published ?? false,
      })),
    },
  };
}

/**
 * Drops a persisted `project-grounding` event before it ever reaches the stream (#1718). The card
 * is session-scoped state — "what grounding the agent has right now" — not conversation history:
 * `App`'s own `[project]`-keyed effect already raises a fresh one on every open (J8 Screen 2's
 * literal "one-time per project open" acceptance), so replaying a persisted copy on top would both
 * duplicate that card (the screen names exactly one) and misreport a stale skill/workflow count,
 * since the counts this card names can change between opens. A deliberate narrowing of the D15
 * "agent-originated card is part of the conversation history a reopened project rehydrates"
 * precedent `TimelinePanel`'s own persisting write side documents (its `incomingCards` effect,
 * which makes the matching exclusion on write) — enforced here too so a store a pre-fix launch
 * already accumulated copies into (CJ's own held eight) stops surfacing them on the very next open,
 * not only on the next one this fix's own write ever reaches.
 */
function isNotProjectGroundingCard(card: TimelineCard): boolean {
  return card.kind !== "project-grounding";
}

function stripSchemaVersion(event: TranscriptEventWire): TimelineCard {
  const card = { ...event } as Record<string, unknown>;
  delete card.schema_version;
  return card as unknown as TimelineCard;
}

/**
 * The one machine-local disposition TD-16 (ruling 5) leaves behind: a change-set card persisted
 * *before* change identity became an opaque string carries its changes' numeric parse ordinals,
 * which name nothing in any live document any more. Each is coerced to an opaque `legacy:<ordinal>`
 * string that cannot collide with a live id (`chg-…` / `snap:…`), so the card renders intact and
 * reads as an honest UXR-Q4 **fail-closed** mismatch — never a wrong decide, and never a card
 * reporting an accept the editor did not make (the display lie a bare numeric id produced once
 * `ChangeSetChange.id` became a string). Read-time only: the transcript is append-only (D15) and
 * nothing here is written back, and a legacy card is deliberately *not* re-joined to records — the
 * durable attribution lives in the committed sidecar and is untouched, so a still-pending change is
 * reachable by triaging the live editor directly.
 *
 * Not a D22 migration: the transcript is machine-local scaffolding (D15, `store::transcript`), not
 * a `.cowrite/` portability contract — no schema moves for this.
 */
function tolerateLegacyChangeIds(card: TimelineCard): TimelineCard {
  if (card.kind !== "change-set") return card;
  const changes = card.changes.map((change) =>
    typeof change.id === "number" ? { ...change, id: `legacy:${change.id}` } : change,
  );
  return { ...card, changes };
}

/**
 * The other machine-local disposition a read has to take: every id a session minted before #1728
 * came from a module counter that restarted with the process, so a store written across several
 * launches holds the same id on genuinely different cards. The stream keys its `VirtualList` rows
 * by card id, so a repeat is a duplicate React key — the list stops reconciling when the filtered
 * set changes, which is the visible "the facet filter does nothing" defect (#1727), and the
 * repeats read as one card rather than the several sessions they record.
 *
 * CJ's own store's eight repeated `project-grounding-1` events were the empirically observed
 * instance of this defect, but `project-grounding` cards no longer reach this function at all —
 * `loadTranscript` drops every one of them before this runs (`isNotProjectGroundingCard`, #1718),
 * since accumulation there was a second, independent defect (a card persisted at all when it never
 * should have been) that a rekeyed id would have merely relabeled, not fixed. This function still
 * has every other card kind's identically-shaped id collision to repair.
 *
 * Each repeat after the first therefore loads under a derived `<id>#n`, skipping any spelling the
 * history itself already claims, so the result is distinct by construction whatever order the
 * collisions arrive in. The first occurrence keeps its persisted id: an unrepeated id is returned
 * byte-identical, so a store written by the fixed generator passes through untouched.
 *
 * Read-time only, exactly like `tolerateLegacyChangeIds` above: the transcript is append-only (D15)
 * and nothing here is written back, and — being machine-local scaffolding rather than a `.cowrite/`
 * portability contract (FR-X-8/D22 govern the sidecars, `docs/formats/sidecar`) — no schema moves
 * for it. A card id is opaque and nothing outside the mounted session joins on it, so a repaired id
 * costs a rehydrated card nothing.
 */
function rekeyRepeatedIds(cards: TimelineCard[]): TimelineCard[] {
  const claimed = new Set(cards.map((card) => card.id));
  const seen = new Set<string>();
  return cards.map((card) => {
    if (!seen.has(card.id)) {
      seen.add(card.id);
      return card;
    }
    let suffix = 2;
    let id = `${card.id}#${suffix}`;
    while (seen.has(id) || claimed.has(id)) {
      suffix += 1;
      id = `${card.id}#${suffix}`;
    }
    seen.add(id);
    return { ...card, id };
  });
}
