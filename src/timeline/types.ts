// ABOUTME: The base timeline-card contract (§3.1 `timeline/`) — every card kind (chat, change-set
// ABOUTME: P2a-14, comment P2a-18, agent activity, review…) extends `TimelineCardBase` by adding a
// ABOUTME: new `kind` variant here and a renderer for it, never by modifying the base card component.
import type { Anchor, CommentThread } from "../comments/types";
import type { ActivityLine, RunPhase } from "./agentActivity";

export interface TimelineCardBase {
  /** Stable identity for React keys and future selection/deep-linking; never reused. */
  id: string;
  /** Discriminant other units extend with their own literal (e.g. `"change-set"`, `"comment"`). */
  kind: string;
  /** ISO 8601 timestamp — chronological order is the stream's one ordering rule (D4/D6). */
  timestamp: string;
}

/** A quoted editor excerpt a chat message carries (FR-CHAT-3, P2b-7, UX Principle 6: "everything
 * in the text deep-links back") — the selection's project-relative document path, text, and
 * `textops::Anchor` (TD-4's shared anchor shape). `TabbedEditor` captures the path from the exact
 * tab emitting the quote, so a later tab switch cannot retarget its transcript or agent context.
 *
 * Two shapes, mirroring `referenceData.ts`'s `OpenDocument` union exactly (D33, CJ 2026-09-03):
 * a path-bearing quote, and a pathless one carrying `label` instead — the same identity convention
 * FR-CHAT-4's `open_documents` already uses, so one shape covers both envelopes. The pathless arm
 * is not yet reachable in production: capturing a *real* pathless quote (`TabbedEditor.tsx`'s quote
 * handler, and the `<UntitledDocument>` quote affordance it doesn't have today) is #2304's wiring,
 * not built here — this only supplies the shape #2312's bound/statement logic needs to describe an
 * over-bound pathless quote (D32/D33's `(q-pathless)`) without waiting on that wiring to land.
 */
export type QuotedExcerpt =
  | {
      // @anchor:quoted-excerpt-document-path
      documentPath: string;
      text: string;
      anchor: Anchor;
    }
  | {
      documentPath: null;
      /** What the tab strip calls this document — the same `label` `OpenDocument`'s own pathless
       * arm carries, so the same words identify it to the user and to the agent. */
      label: string;
      text: string;
      anchor: Anchor;
    };

/** A chat message rendered through the base card (the variant this unit ships). */
export interface ChatMessageCard extends TimelineCardBase {
  kind: "chat-message";
  author: "user" | "agent";
  body: string;
  /** Present exactly when this message was sent with a quoted editor selection attached (P2b-7);
   * omitted for an ordinary message. */
  quote?: QuotedExcerpt;
  /** How many distinct files the run that produced this reply read — J2's `[refs: N files read]`
   * grounding affordance (Principle 3, issue #1391): "keeps grounding observable … without
   * cluttering the prose." Present, and rendered, only on an agent reply the run's own activity
   * feed reports at least one file read for (`agentActivity.ts`'s `distinctFilesRead`); omitted
   * for a user message and for an agent reply that read nothing — J2's "agent asks a clarifying
   * question instead of drafting (normal chat, no special UI)" edge state needs no special-casing
   * because a clarifying question ordinarily reads nothing either. */
  filesRead?: number;
}

/** A comment-thread card (the P2a-18 extension of the base card). `root`/`path` name the thread's
 * document so this card can independently call `comments/ipc.ts` for reply/resolve/reopen/
 * re-anchor — `TimelinePanel` stays comment-agnostic, matching the base card's own "kind-specific
 * fields the shell never interprets" contract. */
export interface CommentCard extends TimelineCardBase {
  kind: "comment";
  root: string;
  path: string;
  /** Present for a pathless thread card; `path` then carries only its human label. */
  docId?: string;
  thread: CommentThread;
}

/** Discriminant for a pending change's redline shape (mirrors `editor/trackedChanges.ts`'s
 * `ChangeKind` and the backend `store::changes::ChangeType` wire tag — kept as its own literal
 * union here, not an import, since `timeline/` and `editor/` are peer frontend modules (§3.1) and
 * this card never touches a live CM6 view). */
export type ChangeSetChangeKind = "insertion" | "deletion" | "substitution";

/** Keep (`accept`) or discard (`reject`) a change — mirrors `editor/trackedChanges.ts`'s
 * `Decision` / `textops::apply::Decision`. */
export type ChangeSetDecision = "accept" | "reject";

/**
 * One pending change in a change-set card (P2a-14) — the `propose_changes` delivery's per-edit
 * shape (P2a-13), trimmed to what the card needs to render and decide: identity, kind, the section
 * it groups under, its old/new text for the popover, and an optional agent note. The actual
 * accept/reject *mechanism* (the live CM6 transaction) belongs to P2a-5 — this shape only carries
 * what the card displays and what a caller needs to invoke that mechanism by id.
 */
export interface ChangeSetChange {
  /**
   * An **opaque string** (TD-16 rulings 1–3) naming one change: the durable TD-4 `chg-<uuid>` its
   * attribution record carries — which is also the id the editor's own parse reports that marker
   * under, so a card's ids and the live field's are the *same* identity, not two schemes that have
   * to be reconciled. A change no record vouches for instead carries a snapshot-scoped
   * `snap:<doc>:<generation>:<ordinal>`, unique across documents and parse generations. Never a
   * value this module or any consumer may parse back into a number, compare numerically, or read
   * for its prefix.
   *
   * Because ids are globally unique, a stale card can no longer resolve against a *different* live
   * change: `EditorShellHandle.decideChanges` simply finds nothing and decides nothing. The
   * `doc`/`generation` gate below is what keeps that honest rather than silent (UXR-Q4).
   */
  id: string;
  kind: ChangeSetChangeKind;
  /** The section label this change groups under (e.g. "§1 Opening") — every change belongs to
   * exactly one section; a delivery with no natural sectioning uses one section for the whole
   * set (D5: fine-grained per-section chunking is a P2 delivery concern — this field only groups
   * whatever chunking the delivery already has). */
  section: string;
  /** The comment thread this change addresses, present exactly when the owning card groups by
   * comment (J4 batch, P2b-3b) instead of by section (P2a-14's original shape) — matches one of
   * that card's `commentGroups[].commentId`. Omitted on a section-grouped card. */
  commentId?: string;
  /** The removed / original side — empty/absent for a pure insertion. */
  oldText?: string;
  /** The added / replacement side — empty/absent for a pure deletion. */
  newText?: string;
  /** Optional agent note (from the delivery metadata) shown in the popover. */
  note?: string;
}

/** ux-design.md §2's four-level severity chip, always rendered as **colour + letter** (`● H`),
 * never colour alone (the accessibility encoding rule) — mirrors the letters
 * `store::comments::Thread.severity`/skill-finding severity will carry once P2b-4b/P2b-5a wire a
 * structured severity onto `CommentThread` itself; this card owns the letter meanwhile since a
 * batch delivery needs it at grouping time regardless of what will eventually feed it. */
export type ChangeSetSeverity = "C" | "H" | "M" | "L";

/**
 * One comment a grouped-by-comment change-set card (J4 batch, P2b-3b) groups changes under —
 * ux-design.md §2's `▸ ● H Eph 4:22 quote (2 chg)`. `commentId` is the thread `changes[].commentId`
 * matches against; deciding this group's changes is this card's job, but resolving/reopening that
 * thread from the decision is the caller's (thread-state authority lives with the batch-address
 * trigger card, P2b-3a, and the backend fold — not this rendering card, FR-CMT-7).
 */
export interface ChangeSetCommentGroup {
  commentId: string;
  /** Short label for the group's `▸` header (e.g. the addressed comment's anchor quote/topic). */
  label: string;
  severity?: ChangeSetSeverity;
}

/**
 * A comment the agent replied to without proposing a change (FR-CMT-4's reply-only defense) —
 * ux-design.md §2's `▸ ⚑ defended: "daily" wording`, listed distinctly on a grouped-by-comment card
 * so it is never swept up by `[Accept all]`/`[Reject all]`: those actions only ever decide
 * `changes`, and a defense carries none, so it is structurally excluded by construction rather than
 * by a special-cased check.
 */
export interface ChangeSetDefense {
  commentId: string;
  label: string;
}

/**
 * Identifies the live tracked-change field a change-set card's ids may be triaged against (UXR-Q4,
 * ux-design §5 + J1 Phase B/C): the document (`doc`, project-relative, matched against the active
 * tab's path) plus a `generation` token naming *which parse* seeded that field. Deciding a card's
 * ids against a field seeded by a *different* parse decides nothing at all (the ids are globally
 * unique since TD-16, so they name no change there) — which the user must be *told*, not left to
 * infer from a card that reports an accept the editor never made. Correspondence therefore requires
 * both to agree — same document AND same generation. See `ChangeSetCard.doc`/`.generation` for the
 * token's identity (the delivered document's revision).
 */
export interface ChangeSetTriageTarget {
  doc: string;
  generation: string | null;
}

/** A change-set card (P2a-14, J1 Phase B/C) — one agent-delivered revision, its summary, and every
 * pending change the three triage entry points (1-by-1 / accept-all / per-section) act on. */
export interface ChangeSetCard extends TimelineCardBase {
  kind: "change-set";
  /**
   * The delivered document this card's changes belong to (project-relative, `notice.doc`) — the
   * `CommentCard.root`/`path` pattern one door down, carried so triage can fail closed (UXR-Q4)
   * rather than decide `card.changes`' ids against whatever document happens to be on screen: a
   * card's ids are only meaningful against *this* document's live tracked-change field. Compared
   * against the active tab's path at decide time (`App.handleChangeSetDecide`) and at render time
   * (the card disables its own controls and names this document when they disagree).
   */
  doc: string;
  /**
   * Which parse produced this card's ids — the delivered document's revision (`notice.revision`,
   * a blake3 of the delivered content, TD-4/UXR-Q4). Seeded identically into the live tracked-change
   * field when the delivery lands (`editor/EditorShell.tsx`'s `applyDelivery`), and into a freshly
   * opened document's field from its own on-disk revision, so a card and the field correspond
   * exactly when their generations match. `null` for a card built before this token existed (never
   * triageable — it fails closed).
   */
  generation: string | null;
  /** The backend's `propose_changes` change_set_id (TD-4 `ChangeRecord.change_set`) — links every
   * change in this card to its attribution record. */
  changeSetId: string;
  /** The agent's own note describing the revision (e.g. "Tightened hook; fixed 2 citations."). */
  summary: string;
  changes: ChangeSetChange[];
  /** Present exactly when this card groups by comment (J4 batch, P2b-3b) instead of by section
   * (P2a-14's original shape) — the per-comment group metadata `changes[].commentId` groups
   * against, in delivery order. `undefined`/omitted renders the original per-section card. */
  commentGroups?: ChangeSetCommentGroup[];
  /** Reply-only defenses (FR-CMT-4) this delivery produced alongside `changes` — rendered
   * distinctly and never counted into or swept up by the accept/reject-all actions. Empty/omitted
   * on a section-grouped card. */
  defenses?: ChangeSetDefense[];
  /** How many explanatory replies this delivery posted across every addressed comment (J4 header's
   * "5 replies") — an informational total only; the replies themselves live on the comment
   * threads, not on this card. */
  replyCount?: number;
}

/** Frontend-only acknowledgement phases. Rust `RunPhase` has no queued or cancelled counterpart:
 * queued runs have not spawned, so their acknowledgement and cancellation resolve synchronously. */
export type ClientRunPhase = { phase: "queued"; position: number } | { phase: "cancelled" };

/** A live-or-resolved agent run (P2a integration #345, J1 Phase A "Working" / ux-design §2 Agent
 * states) — the timeline's rendering of one `agent::run_queue::RunStatus`. `runId` doubles as
 * this card's own `id` by construction (see `createAgentWorkingCard`), so a later push for the
 * same run updates this card in place instead of ever minting a second one. */
export interface AgentWorkingCard extends TimelineCardBase {
  kind: "agent-working";
  runId: string;
  phase: RunPhase | ClientRunPhase;
  activity: ActivityLine[];
  elapsedSecs: number;
  /** J13 submit-time disclosure on a composer-less batch run; persisted with its terminal card. */
  outboundContext?: string;
}

/** The shared shape accepted by the agent card factory: a backend `RunStatus` push or the
 * frontend's synchronous queued acknowledgement before that run becomes active. */
export interface AgentRunCardStatus {
  id: string;
  phase: AgentWorkingCard["phase"];
  activity: ActivityLine[];
  elapsedSecs: number;
}

/**
 * A document-birth card (J2 Phase B, FR-CHAT-2) — a successful `create_document` call: the agent
 * wrote a new draft, the app opened it as a tab, and the conversation stayed the same thread (D4).
 *
 * J2's own wireframe (ux-design.md §3) also shows a doc-kind line (e.g. "Sermonette · 1,480 words")
 * and a `via skill:` attribution — `create_document(path, content)` carries neither and no ratified
 * channel supplies them (issue #420 scope note): this card renders only what the tool call itself
 * returned, the created path, plus the size of what it wrote. Never invent tool fields for the
 * annotation.
 */
export interface DocumentBirthCard extends TimelineCardBase {
  kind: "document-birth";
  /** The created document, project-relative — matches `create_document`'s own response `path`. */
  path: string;
  /** The written content's size in bytes. */
  size: number;
}

/** D15 projection of a durable omission-aware UntitledDocument Save As adoption event. */
export interface UntitledAdoptionCard extends TimelineCardBase {
  kind: "untitled-adoption";
  adoptionId: string;
  displacedPath: string;
  destination: string;
  recoveryContentOmitted?: boolean;
  movedCommentCount?: number;
}

/** One discovered skill, as the project card lists it (name + description, tap to list them) —
 * mirrors the backend `commands::skills::GroundingSkillPayload`, never the file body (FR-SKILL-2/
 * D10). */
export interface GroundingSkill {
  name: string;
  description: string;
}

/** One discovered workflow — the default glob carries no frontmatter requirement (FR-SKILL-5), so
 * there is no description to list, only a name. */
export interface GroundingWorkflow {
  name: string;
}

/**
 * The project card (P2b-8b, J8 Screen 2, FR-SKILL-1): a one-time, per-project-open summary of
 * what grounding the agent has — *"Found 9 skills, 5 workflows, CLAUDE.md"* — that expands (tap)
 * to list every discovered skill/workflow by name and description. Raised exactly once per project
 * open (`App`'s own `[project]`-keyed effect mints it, never a per-refresh re-raise — the J8
 * acceptance's literal "one-time" wording) and always raised, even when every count is zero
 * (Principle 7: a silently omitted card would leave a mis-configured repo looking identical to a
 * well-grounded one — "found nothing" is itself information).
 */
export interface ProjectGroundingCard extends TimelineCardBase {
  kind: "project-grounding";
  skills: GroundingSkill[];
  workflows: GroundingWorkflow[];
  /** The repo instruction file's on-disk name (e.g. `"CLAUDE.md"`), present exactly when the
   * project has one at its root — omitted, never a placeholder, when it doesn't (FR-SKILL-1's
   * "the repo instruction file if present"). */
  instructionFile?: string;
}

/**
 * The stream's card union. Other units add their own interface (extending `TimelineCardBase`) and
 * widen this union plus the render-switch in `TimelinePanel` — the base card and virtualization
 * stay untouched (the "extend without modifying" contract the issue calls for).
 */
export type TimelineCard =
  | ChatMessageCard
  | CommentCard
  | ChangeSetCard
  | AgentWorkingCard
  | DocumentBirthCard
  | UntitledAdoptionCard
  | ProjectGroundingCard;

/** Separates *this* process's fallback ids from every other process's — see `nextId` (#1728). */
const sessionSalt = `${Date.now().toString(36)}${Math.random().toString(36).slice(1)}`;
let counter = 0;

/**
 * Mints a card id unique for the lifetime of the transcript it is written into (D15), not merely
 * within one session. Cards are persisted and rehydrated on the next launch, so any generator that
 * restarts with the process hands two different cards the same identity permanently — duplicate
 * `VirtualList` React keys, which is why the stream's facet filtering visibly stops reconciling
 * (#1728, root cause of #1718/#1727).
 *
 * `crypto.randomUUID` is the generator wherever the webview exposes it — the same `run-<uuid>`
 * shape the backend's own run ids use (`agent/run_queue.rs`). Where it is not exposed (a webview
 * served from a non-secure context, an older jsdom) the fallback still separates sessions by a
 * per-process salt: a bare counter is reachable in production here, so it can never be the
 * fallback, whatever a comment claims about it being one.
 */
function nextId(prefix: string): string {
  const webCrypto: Crypto | undefined = globalThis.crypto;
  if (typeof webCrypto?.randomUUID === "function") return `${prefix}-${webCrypto.randomUUID()}`;
  counter += 1;
  return `${prefix}-${sessionSalt}-${counter}`;
}

export interface CreateChatMessageCardOptions {
  id?: string;
  timestamp?: string;
  /** The quoted editor selection (P2b-7), if any, this message was sent with — see
   * `ChatMessageCard.quote`'s own docs. */
  quote?: QuotedExcerpt;
  /** See `ChatMessageCard.filesRead`'s own docs (#1391). */
  filesRead?: number;
}

/** Builds a `ChatMessageCard` — the one factory the message input and any future agent-reply path
 * both call, so every chat card in the stream has the same shape. */
export function createChatMessageCard(
  author: ChatMessageCard["author"],
  body: string,
  { id, timestamp, quote, filesRead }: CreateChatMessageCardOptions = {},
): ChatMessageCard {
  return {
    id: id ?? nextId("chat-message"),
    kind: "chat-message",
    author,
    body,
    quote,
    filesRead,
    timestamp: timestamp ?? new Date().toISOString(),
  };
}

export interface CreateCommentCardOptions {
  id?: string;
  timestamp?: string;
}

/** Builds a `CommentCard` for `thread` — what a comment surface (once wired to a real editor
 * selection/backend call) hands `TimelinePanel` after creating or loading a thread. */
export function createCommentCard(
  root: string,
  path: string,
  thread: CommentThread,
  { id, timestamp }: CreateCommentCardOptions = {},
): CommentCard {
  return {
    id: id ?? nextId("comment"),
    kind: "comment",
    root,
    path,
    thread,
    timestamp: timestamp ?? new Date().toISOString(),
  };
}

export interface CreateChangeSetCardOptions {
  id?: string;
  timestamp?: string;
  /** The delivered document and its parse generation (UXR-Q4) — see `ChangeSetCard.doc`/`.generation`.
   * Both default empty (`""`/`null`), i.e. a card that corresponds to no live field and so can never
   * be triaged; a real delivery supplies them (`changeSetCardFor`). */
  doc?: string;
  generation?: string | null;
  /** Supplied for a J4 batch (grouped-by-comment) delivery only — see `ChangeSetCard`'s own docs. */
  commentGroups?: ChangeSetCommentGroup[];
  defenses?: ChangeSetDefense[];
  replyCount?: number;
}

/** Builds a `ChangeSetCard` for a `propose_changes` delivery — what the session/event wiring
 * (once it lands) hands `TimelinePanel` alongside seeding the live editor's tracked-change set.
 * Omitting `commentGroups` builds P2a-14's original per-section card; supplying it builds P2b-3b's
 * grouped-by-comment batch card instead — one factory, one shape, branching only on the data a
 * caller has. */
export function createChangeSetCard(
  changeSetId: string,
  summary: string,
  changes: ChangeSetChange[],
  { id, timestamp, doc, generation, commentGroups, defenses, replyCount }: CreateChangeSetCardOptions = {},
): ChangeSetCard {
  return {
    id: id ?? nextId("change-set"),
    kind: "change-set",
    doc: doc ?? "",
    generation: generation ?? null,
    changeSetId,
    summary,
    changes,
    commentGroups,
    defenses,
    replyCount,
    timestamp: timestamp ?? new Date().toISOString(),
  };
}

export interface CreateAgentWorkingCardOptions {
  /** Overrides the default `status.id`-as-card-id (see `AgentWorkingCard`'s own docs) — never
   * needed by `TimelinePanel` itself; exists for a test that wants a card id distinct from its
   * run id. */
  id?: string;
  timestamp?: string;
}

/** Builds an `AgentWorkingCard` from an `agentActivity.ts` `RunStatus` push — what
 * `TimelinePanel`'s `agent://activity` listener hands into the stream the first time it sees a
 * given run id; a later push for the same run id updates the existing card's fields in place
 * instead of calling this again (`TimelinePanel`'s own docs) — one card per run, by construction,
 * since the default `id` is the run id itself. */
export function createAgentWorkingCard(
  status: AgentRunCardStatus,
  { id, timestamp }: CreateAgentWorkingCardOptions = {},
): AgentWorkingCard {
  return {
    id: id ?? status.id,
    kind: "agent-working",
    runId: status.id,
    phase: status.phase,
    activity: status.activity,
    elapsedSecs: status.elapsedSecs,
    timestamp: timestamp ?? new Date().toISOString(),
  };
}

export interface CreateDocumentBirthCardOptions {
  id?: string;
  timestamp?: string;
}

/** Builds a `DocumentBirthCard` for a landed `create_document` call — what
 * `stores/documentBirth.ts`'s subscription hands `App` (via `TimelinePanel`'s `incomingCards`) once
 * the tool's write has actually landed (#420, J2 Phase B). */
export function createDocumentBirthCard(
  path: string,
  size: number,
  { id, timestamp }: CreateDocumentBirthCardOptions = {},
): DocumentBirthCard {
  return {
    id: id ?? nextId("document-birth"),
    kind: "document-birth",
    path,
    size,
    timestamp: timestamp ?? new Date().toISOString(),
  };
}

export interface CreateProjectGroundingCardOptions {
  id?: string;
  timestamp?: string;
}

/** Builds a `ProjectGroundingCard` from a `discover_grounding` result — what `App`'s own
 * `[project]`-keyed effect hands `TimelinePanel` (via `incomingCards`) once per project open
 * (`stores/grounding.ts`'s `groundingCardFor`). */
export function createProjectGroundingCard(
  skills: GroundingSkill[],
  workflows: GroundingWorkflow[],
  instructionFile: string | undefined,
  { id, timestamp }: CreateProjectGroundingCardOptions = {},
): ProjectGroundingCard {
  return {
    id: id ?? nextId("project-grounding"),
    kind: "project-grounding",
    skills,
    workflows,
    instructionFile,
    timestamp: timestamp ?? new Date().toISOString(),
  };
}
