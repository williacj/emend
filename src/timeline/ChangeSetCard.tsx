// ABOUTME: The change-set card (P2a-14, J1 Phase B/C) — summary/count header, expandable
// ABOUTME: per-section (▸) groups, and the triage entry points into P2a-5's accept/reject
// ABOUTME: mechanism: [Review 1-by-1] (a focused pass reusing the identical `RedlinePopover`),
// ABOUTME: [Accept all]/[Reject all], per-section accept/reject scoped to one group, and (P2b-2,
// ABOUTME: J1-Q1) an overflow menu of type-filtered bulk ops scoped to this change set. Also
// ABOUTME: renders P2b-3b's J4 grouped-by-comment batch variant (`card.commentGroups`), the same
// ABOUTME: card shape grouped by comment instead of section, with defenses (FR-CMT-4) listed
// ABOUTME: distinctly outside the accept/reject-all sweep, and (P2b-1b) collapses to a single line
// ABOUTME: by default once every change is decided. Its expanded body also reports UXR-Q5 decision
// ABOUTME: provenance when this card reaches outside its set or its own changes are decided elsewhere.
import { useEffect, useRef, useState } from "react";
import { RedlinePopover } from "../editor/RedlinePopover";
import { useDismissOnOutsideOrEscape } from "../useDismissOnOutsideOrEscape";
import { relativeTimestamp } from "./ChatMessageCard";
import {
  advanceChangeSetReview,
  currentReviewChangeId,
  reviewProgress,
  startChangeSetReview,
  type ChangeSetReviewState,
} from "./changeSetReview";
import { isChangeSetCollapsedByDefault } from "./collapse";
import { mergeDecidedIds, removeDecidedIds } from "./decidedIds";
import { TimelineCard } from "./TimelineCard";
import type {
  ChangeSetChange,
  ChangeSetChangeKind,
  ChangeSetCommentGroup,
  ChangeSetDecision,
  ChangeSetCard as ChangeSetCardData,
  ChangeSetSeverity,
  ChangeSetTriageTarget,
} from "./types";

/** The two J1-named types (J1-Q1) a type-filtered bulk op targets — a substitution matches neither
 * (module docs on `types.ts`'s `ChangeSetChangeKind`; the same deliberate carve-out
 * `editor/trackedChanges.ts`'s `ChangeTypeFilter` documents and owns). */
type TypeFilter = Extract<ChangeSetChangeKind, "insertion" | "deletion">;

const TYPE_FILTER_OPTIONS: readonly { filter: TypeFilter; decision: ChangeSetDecision; label: string }[] = [
  { filter: "insertion", decision: "accept", label: "Accept all insertions" },
  { filter: "insertion", decision: "reject", label: "Reject all insertions" },
  { filter: "deletion", decision: "accept", label: "Accept all deletions" },
  { filter: "deletion", decision: "reject", label: "Reject all deletions" },
];

export interface ChangeSetCardProps {
  card: ChangeSetCardData;
  /**
   * Called once per decision with every id it covers in a single call — accept-all/reject-all/
   * per-section each fire exactly one call carrying their whole id set, matching FR-AGENT-6's "no
   * partial-applied intermediate state observable" at this interface (the actual apply — e.g. a
   * batched CM6 transaction against the live editor, P2a-5 — is the caller's job; this component
   * only tracks decided ids locally so its own counts/entry points reflect what's left pending).
   *
   * A type-filtered pick is the first entry point that can structurally pass a strict subset of a
   * live group (P4b): the caller's own decision mechanism (`editor/trackedChanges.ts`'s
   * `decisionsTransaction`) sweeps in that group's other member too. If the caller does that, it
   * should return the *full* set of ids it actually decided (the passed ids plus any swept-in
   * co-member) so this card's own pending/decided bookkeeping doesn't go stale on the co-member it
   * never explicitly passed. Returning an empty array explicitly refuses the decision — no id is
   * retired from the card — while returning nothing (or omitting the callback) keeps the passed
   * `ids` as the decided set, unchanged for callers that have no group linkage to report back.
   */
  // @anchor:change-set-card-on-decide
  onDecide?: (ids: string[], decision: ChangeSetDecision) => string[] | void;
  /**
   * Called when the 1-by-1 pass focuses a change (on entering the pass, and after each
   * Accept & next/Reject & next) — the caller scrolls the live editor to it. Never called outside
   * that explicit user action (no focus steal, Principle 2). Omitted in a caller with no live
   * editor yet (e.g. tests).
   */
  onFocusChange?: (id: string) => void;
  /** Fires whenever this card's own effective collapsed state changes — on mount (reporting the
   * initial value) and after every toggle, including the automatic collapse a decision completing
   * the set triggers (P2b-1b). Lets `TimelinePanel` size this card's virtualized row from it
   * (`timeline/collapse.ts`'s `itemHeightFor`) without needing to keep this card mounted to know.
   *
   * `explicit` distinguishes a value the *user* chose (a click on Expand/Collapse) from one the
   * collapse rule merely produced — note that the automatic collapse on deciding the last change is
   * the *rule*, not a choice, and so reports `explicit: false`. The caller must not conflate them:
   * the effective value sizes the row, but only an explicit choice may be pinned back via
   * `initialCollapsed` on remount (review finding, PR #481). */
  onCollapsedChange?: (collapsed: boolean, explicit: boolean) => void;
  /** Seeds this card's collapse override on mount from the caller's record of a choice **the user
   * explicitly made** for this card (`TimelinePanel`'s `pinnedCollapsedIds` map, keyed by card id).
   * Fixes the round trip through a card leaving the virtualized window: without this,
   * `collapsedOverride` reset to `null` on remount and a user's explicit expand of a fully-decided
   * change set was silently discarded — the row snapped back collapsed (review finding, PR #481).
   *
   * Pass this **only** for a card whose `onCollapsedChange` reported `explicit: true`. `undefined`
   * (the default — every caller with no such record, and every card the user has merely looked at)
   * leaves the card following `defaultCollapsed`, which is what keeps the collapse-by-default rule
   * live across remounts. */
  initialCollapsed?: boolean;
  /**
   * Ids of this card's own `changes` decided *outside* this card entirely — the mounted timeline's
   * app-shell wiring (#410) reports these here when the live editor resolves a change some other
   * way (in-editor toolbar/keyboard/popover triage), including any group co-member swept in with
   * it (P4b), so this card's own pending counts stay honest even for a decision it never itself
   * dispatched. Reconciled into the same local `decided` set `onDecide`'s return value feeds —
   * decision batches are superset-only, so a later render with a *smaller* set (or omitted
   * entirely) never removes an id this card already retired. Only `externallyReversedIds` removes
   * ids. Omitted by callers with no live-editor seam to report through (e.g. component tests). */
  externallyDecidedIds?: ReadonlySet<string>;
  /** One undo event's restored ids; matching ids return to Pending with no residual status.
   * The batch is an event, not durable state: a card first mounting with an existing batch ignores
   * it because `externallyDecidedIds` already reflects that reversal. */
  externallyReversedIds?: readonly string[];
  /** Number of still-decided ids outside this card's set that its own actions reached (UXR-Q5).
   * The panel owns the underlying ids so this accounting survives virtualized card remounts and
   * derives undo/redo visibility from the live decided set; this card only renders the body note. */
  reachedChangeCount?: number;
  /** Number of this card's own currently-decided ids that another surface decided (UXR-Q5).
   * The panel owns the provenance across virtualized remounts; this card only renders the
   * persistent, non-interactive body status. */
  decidedElsewhereCount?: number;
  /**
   * The active tab's triage target (UXR-Q4) — the document and parse generation the live
   * tracked-change field currently holds. This card may only be triaged when its own `card.doc` and
   * `card.generation` both match it; otherwise its ids name changes that field does not hold, and
   * deciding them would do nothing at all while the card reported an accept the editor never made
   * (a display lie — TD-16 removed the *wrong-text* outcome, not the need to say so). On a mismatch
   * the card disables every triage control and names `card.doc` instead, and
   * `decide` refuses to call `onDecide` at all — never a silent no-op, never a silent wrong decide.
   * The naming branches on *which* mismatch: a different (or absent) document says "open it", while
   * a stale parse of the document already on screen points at the FR-ED-7 reload that resolves it —
   * a degraded state has to name an action the user can actually take (FR-X-5).
   *
   * Three-way meaning: `undefined` (omitted) leaves the card **ungated** — a caller with no live
   * editor wired (this component's own tests, or a panel before the editor is mounted), where the
   * card behaves exactly as before this prop existed; explicit `null` (an editor is wired but no tab
   * is active) reads as a mismatch, as does any target whose document/generation differs. Cross-
   * document routing and re-focus (so a mismatch could *become* a match by switching tabs) are
   * *mechanically* safe since TD-16 made ids globally unique, but the affordance itself is a J#
   * design question and is not offered here; today a mismatch is an honest, disabled refusal.
   */
  triageTarget?: ChangeSetTriageTarget | null;
}

interface ChangeSetSection {
  name: string;
  changes: ChangeSetChange[];
}

/** Groups `changes` by their `section`, preserving each section's first-appearance order. */
function sectionsOf(changes: ChangeSetChange[]): ChangeSetSection[] {
  const order: string[] = [];
  const bySection = new Map<string, ChangeSetChange[]>();
  for (const change of changes) {
    let bucket = bySection.get(change.section);
    if (!bucket) {
      bucket = [];
      bySection.set(change.section, bucket);
      order.push(change.section);
    }
    bucket.push(change);
  }
  return order.map((name) => ({ name, changes: bySection.get(name) as ChangeSetChange[] }));
}

/** ux-design.md §2's accessibility rule: severity is never colour alone — always colour + letter.
 * The letter is plain text content (not just an aria-label), so it reads without colour or a
 * screen reader either. */
function SeverityChip({ severity }: { severity: ChangeSetSeverity }) {
  return (
    <span
      className="change-set-card__severity"
      data-severity={severity}
      aria-label={`severity: ${severity}`}
    >
      ● {severity}
    </span>
  );
}

interface ChangeSetCommentPending {
  commentId: string;
  label: string;
  severity?: ChangeSetSeverity;
  changes: ChangeSetChange[];
  /** Whether this group's delivery ever included a change at all (`card.changes`, not `pending`) —
   * distinct from `changes.length` (which shrinks as the group's changes are decided). A group that
   * never had a change to begin with (J4 Batch, `batchChangeSetCard.ts`: nothing yet ties a batch
   * delivery's changes back to a comment id, P2a-15) stays listed permanently with a `(0)` count and
   * no Accept/Reject controls — there is nothing to sweep, but the comment it addressed is still
   * named. A group that *had* changes and has since had every one decided still disappears, exactly
   * as before (mirrors `sectionsOf` dropping an emptied-out section). */
  everHadChanges: boolean;
}

/** Groups `changes` by `card.commentGroups`, in that delivery order. `total` (the full delivery,
 * decided or not) distinguishes a group that started empty from one merely fully decided (see
 * `ChangeSetCommentPending.everHadChanges`); only the latter gets dropped, matching `sectionsOf`
 * dropping an emptied-out section. A change whose `commentId` names no declared group is omitted
 * (a malformed delivery, not this card's job to repair) rather than silently inventing a group for
 * it. */
function commentGroupsOf(
  groups: ChangeSetCommentGroup[],
  total: ChangeSetChange[],
  pending: ChangeSetChange[],
): ChangeSetCommentPending[] {
  return groups
    .map((group) => ({
      commentId: group.commentId,
      label: group.label,
      severity: group.severity,
      changes: pending.filter((change) => change.commentId === group.commentId),
      everHadChanges: total.some((change) => change.commentId === group.commentId),
    }))
    .filter((group) => group.changes.length > 0 || !group.everHadChanges);
}

export function ChangeSetCard({
  card,
  onDecide,
  onFocusChange,
  onCollapsedChange,
  initialCollapsed,
  externallyDecidedIds,
  externallyReversedIds,
  reachedChangeCount = 0,
  decidedElsewhereCount = 0,
  triageTarget,
}: ChangeSetCardProps) {
  // UXR-Q4 fail-closed gate. `undefined` (prop omitted) means no live-editor context is wired — the
  // card stays ungated, exactly as before this prop existed (this component's own tests, a panel
  // mounted before the editor). Otherwise this card is triageable only when its own document and
  // parse generation both match the live field's: a different document, a stale parse (a suppressed
  // dirty-tab delivery), or no active tab at all (`null`) each read as a mismatch, whereupon every
  // triage control below disables and the card names its document instead of deciding wrong text.
  const gated = triageTarget !== undefined;
  const mismatch =
    gated && (triageTarget === null || card.doc !== triageTarget.doc || card.generation !== triageTarget.generation);

  // Locally tracks which of this card's changes have been decided — which decision is the caller's
  // own concern via `onDecide` — so the header/section counts and entry points reflect what's left
  // pending. The actual apply lives with the caller; this is purely this card's own rendering
  // state, reconciled against whatever id set `onDecide` reports back (see its doc comment) so a
  // caller-side group sweep (P4b) doesn't leave a decided change reported as still pending.
  const [decided, setDecided] = useState<Set<string>>(new Set());

  // Reconciles a decision the live editor made outside this card entirely (#410's editor→card
  // direction) into the same `decided` set `decide` below feeds — but only while this card can
  // verify the report against the live document/generation (UXR-Q5 rule 2). A smaller/empty decision
  // batch cannot un-decide an id; only the explicit reversal event below removes ids.
  useEffect(() => {
    if (mismatch || !externallyDecidedIds || externallyDecidedIds.size === 0) return;
    // @anchor:change-set-card-merge-decided-ids
    setDecided((prev) => mergeDecidedIds(prev, externallyDecidedIds));
  }, [externallyDecidedIds, mismatch]);

  // A reversal is a one-shot event, while virtualized cards mount and unmount independently of the
  // panel that owns the durable decided-id accumulator. Seed the ref with the mount-time batch so
  // a remount cannot replay an old undo after that id has since been re-decided. A fresh array
  // received during this card instance's lifetime is the only batch this local state must subtract.
  const previousReversedIds = useRef(externallyReversedIds);
  useEffect(() => {
    if (externallyReversedIds === previousReversedIds.current) return;
    previousReversedIds.current = externallyReversedIds;
    if (!externallyReversedIds || externallyReversedIds.length === 0) return;
    setDecided((prev) => removeDecidedIds(prev, externallyReversedIds));
  }, [externallyReversedIds]);

  const [review, setReview] = useState<ChangeSetReviewState | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDetailsElement>(null);
  // `null` follows the P2b-1b default (collapsed exactly when every change is decided); a click
  // pins an explicit choice that survives the set staying fully decided. Seeded from
  // `initialCollapsed` so that pinned choice also survives this component unmounting and
  // remounting — e.g. scrolling out of and back into the virtualized window. The caller passes it
  // only for a choice the user actually made; staying `null` for the rest is what keeps the default
  // rule live across remounts (review finding, PR #481).
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(initialCollapsed ?? null);

  // Native `<details>` closes on neither Escape nor an outside click; the overflow menu is a
  // transient pick-one surface, so it dismisses like one (the toolbar's twin,
  // `editor/TrackChangesBulkMenu.tsx`, shares this same hook).
  useDismissOnOutsideOrEscape(overflowOpen, overflowRef, setOverflowOpen);

  // The two kinds of mismatch want opposite instructions. A stale parse of the document already on
  // screen (the UXR-Q3-suppressed dirty-tab delivery) cannot be resolved by "open it" — the user is
  // looking at it. The delivery is on disk, so the FR-ED-7 banner's Reload is the action that takes
  // it; naming the other one would instruct the impossible (FR-X-5: a degraded state must be honest
  // about the way out, not merely about being degraded).
  const staleSameDocument = mismatch && triageTarget != null && card.doc === triageTarget.doc;
  const mismatchMessage = staleSameDocument
    ? `These changes are saved to ${card.doc} — this tab does not match them, so reload the file to review them.`
    : `These changes apply to ${card.doc || "another document"} — open it to review them.`;
  // A card with no changes at all (J4 Batch, before P2a-15 ties a delivery back to a comment id)
  // has nothing a mismatch could actually block — every triage control is already disabled because
  // there is nothing to decide, not because of the mismatch. Naming a document to "open ... to
  // review them" when there is nothing to review instructs an action the user cannot usefully take
  // (FR-X-5, review finding #537); `decide` still refuses on a mismatch regardless (the belt this
  // banner is only the suspenders for), so suppressing the banner here changes no triage outcome.
  const showMismatchBanner = mismatch && card.changes.length > 0;

  const pending = card.changes.filter((change) => !decided.has(change.id));

  // P2b-1b: collapses to a single line once every change is decided — the "fully decided, not any
  // decision" boundary (`isChangeSetCollapsedByDefault` — the same predicate `collapse.test.ts`
  // pins directly). A caller override (a click) survives the set staying fully decided.
  const defaultCollapsed = isChangeSetCollapsedByDefault(card.changes, decided);
  const collapsed = collapsedOverride ?? defaultCollapsed;
  const toggleCollapse = () => setCollapsedOverride(!collapsed);

  // Reports the *effective* collapsed value to the caller on mount and on every change — the seam
  // `TimelinePanel` sizes this card's virtualized row from (`timeline/collapse.ts`'s `itemHeightFor`)
  // — alongside whether that value is the user's own choice, which is the only thing the caller may
  // pin back on remount.
  useEffect(() => {
    onCollapsedChange?.(collapsed, collapsedOverride !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onCollapsedChange identity shouldn't retrigger
  }, [collapsed, collapsedOverride]);

  const groupedByComment = card.commentGroups !== undefined;
  const sections = sectionsOf(pending);
  const commentGroups = card.commentGroups ? commentGroupsOf(card.commentGroups, card.changes, pending) : [];
  // J4's "ADDRESSED N COMMENTS" total (header) and the "N changes · N replies · N defenses" line
  // are both fixed at delivery time — every comment/change/reply/defense this batch produced,
  // whether or not its group has since been decided — unlike the pending group list below, which
  // shrinks as groups are fully decided. This mirrors a section-grouped card's own summary line
  // reading "3 changes" against a delivery, except there `pending.length` *is* the delivery total
  // (no accept/reject-all path can leave a section only partially decided); on a grouped-by-comment
  // card the header/counts intentionally do not track `pending`.
  const addressedCount = (card.commentGroups?.length ?? 0) + (card.defenses?.length ?? 0);
  // On a grouped card, only changes visibly listed under a `▸` group are swept by Accept
  // all/Reject all — a change whose `commentId` names no declared group (a malformed delivery) is
  // never rendered under any group, so it must not be silently decided by a sweep the user can't
  // see acting on it either. It still surfaces (and can be decided) via `Review 1-by-1`, which
  // walks every pending change regardless of grouping.
  const sweepIds = groupedByComment
    ? commentGroups.flatMap((group) => group.changes.map((change) => change.id))
    : pending.map((change) => change.id);

  const decide = (ids: string[], decision: ChangeSetDecision): string[] => {
    // Fail closed (UXR-Q4): never route a decision whose ids belong to a parse the live field no
    // longer holds. The controls are already disabled on a mismatch; this is the belt to that
    // suspenders, so no programmatic or racing path can slip a wrong decide through either.
    if (mismatch) return [];
    if (ids.length === 0) return [];
    // The caller may report back a wider id set than was passed (a swept-in group co-member), or an
    // explicit empty set when none of these ids resolved in the live field — see the `onDecide` doc
    // comment. Fall back to the passed `ids` only when the caller reports no set at all.
    const settled = onDecide?.(ids, decision) ?? ids;
    if (settled.length === 0) return [];
    setDecided((prev) => new Set([...prev, ...settled]));
    return settled;
  };

  /** "Accept/reject all insertions/deletions" (P2b-2, J1-Q1), scoped to this change set: narrows
   * the same `sweepIds` set Accept all/Reject all act on to `filter`'s kind and decides it in the
   * one `decide` call above — the same single-call, no-partial-state contract `decide` already
   * gives accept-all/per-section (FR-AGENT-6). Narrowing `sweepIds` rather than `pending` is what
   * keeps a grouped-by-comment card's ungrouped change (P2b-3b) out of *every* sweep, not just the
   * untyped ones — a bulk op the user can't see acting on a change must not decide it.
   *
   * The result is deliberately a *strict subset* of a live group when a type filter matches only one
   * side of it — group atomicity (P4b) is the live-editor caller's concern once `onDecide`'s ids
   * reach it (`editor/trackedChanges.ts`'s `decisionsTransaction` sweeps in a matched id's group and
   * reports the full set back); this card never decides text itself.
   *
   * ***Scope note (CJ-ratified 2026-07-21, #416):* group closure is not bounded by the change set.**
   * The ids this function narrows to are always a subset of *this card's own* `card.changes` —
   * `typeFilterIds` cannot itself reach outside this change set. But the live document's grouping is
   * positional (`editor/trackedChanges.ts`'s `autoGroups`: an adjacent deletion-then-insertion pair),
   * not authorial, so nothing prevents a group co-member from having been delivered under a
   * *different* change-set card (or none at all). When that happens **atomicity wins over card
   * scope**: the whole group still decides together, reaching outside this card's own `changes` via
   * `decisionsTransaction`'s group closure. P4b (`docs/test-plan.md`) carries no scope qualifier —
   * "deciding any member of a group … decides the group atomically, all-or-none" — so this is P4b
   * *applied*, not amended, and it needs no P4b delta. Recorded in `docs/ux-design.md` §2 (above the
   * UXR-Q5 provenance inventory), which is the owning document for the user-facing consequence.
   *
   * The swept-in co-member's own card retires it not through this card's `onDecide` (which never
   * named that id) but through #410's `externallyDecidedIds` reconciliation, mounted identically on
   * every change-set card in the panel — see the two `(#416)`-tagged tests in `App.test.tsx`'s
   * "change-set triage wiring (#410)" describe block for the mounted, real-`EditorView` proof of both
   * halves: the ordinary case (no group crosses a card boundary, so a type filter here never touches a
   * sibling card's changes) and the P4b edge case (it does, and the whole group moves together).
   *
   * **User-facing accounting (#569):** UXR-Q5's post-action
   * `↳ also decided N linked changes outside this set` note is derived one level up in
   * `TimelinePanel`, where the returned ids can survive this card's virtualized remount and be
   * subtracted by the reversal event above. This component receives only the resulting count.
   */
  const typeFilterIds = (filter: TypeFilter) =>
    pending.filter((change) => change.kind === filter && sweepIds.includes(change.id)).map((change) => change.id);

  const decideByType = (filter: TypeFilter, decision: ChangeSetDecision) => {
    decide(typeFilterIds(filter), decision);
  };

  const enterReview = () => {
    if (mismatch) return;
    const ids = pending.map((change) => change.id);
    if (ids.length === 0) return;
    setReview(startChangeSetReview(ids));
    onFocusChange?.(ids[0]);
  };

  const exitReview = () => setReview(null);

  const decideCurrentAndAdvance = (decision: ChangeSetDecision) => {
    if (!review) return;
    const id = currentReviewChangeId(review);
    if (id === undefined) return;
    if (decide([id], decision).length === 0) return;
    const next = advanceChangeSetReview(review, id);
    const nextId = currentReviewChangeId(next);
    setReview(nextId === undefined ? null : next);
    if (nextId !== undefined) onFocusChange?.(nextId);
  };

  const currentChange = review
    ? pending.find((change) => change.id === currentReviewChangeId(review))
    : undefined;
  const progress = review ? reviewProgress(review) : null;

  // P2b-1b: a fully-decided change-set renders collapsed to a single line by default — a display
  // layer over the triage rendering below, not a replacement for it (expanding reveals the
  // identical rendering this early return skips). Still wrapped in the same `TimelineCard` shell so
  // `data-card-id`/`data-card-kind` stay stable for anything selecting this card by identity.
  if (collapsed) {
    return (
      <TimelineCard id={card.id} kind={card.kind} compact>
        {/* No `aria-label` here (review finding, PR #481): it would override the summary/status
            spans below as the accessible name, erasing them from assistive tech. The
            visually-hidden "Expand" span becomes the first word of the name those spans already
            form, naturally. */}
        <button type="button" className="change-set-card__collapsed" aria-expanded={false} onClick={toggleCollapse}>
          <span className="sr-only">Expand</span>
          <span className="change-set-card__summary">{card.summary}</span>
          <span className="change-set-card__collapsed-status">
            {card.changes.length} {card.changes.length === 1 ? "change" : "changes"} decided
          </span>
        </button>
      </TimelineCard>
    );
  }

  return (
    <TimelineCard
      id={card.id}
      kind={card.kind}
      header={
        <>
          {groupedByComment ? (
            <span className="change-set-card__header">
              ADDRESSED {addressedCount} {addressedCount === 1 ? "COMMENT" : "COMMENTS"} · Agent
            </span>
          ) : (
            <span className="change-set-card__attribution">
              <span className="change-set-card__badge">REVISION</span>
              <span className="change-set-card__author">Agent</span>
              <time className="change-set-card__timestamp" dateTime={card.timestamp}>
                {relativeTimestamp(card.timestamp, Date.now())}
              </time>
            </span>
          )}
          {/* Only a set the collapse rule actually applies to (fully decided) gets a manual
              re-collapse control — reaching this branch with `defaultCollapsed` true means the
              user already forced an expand, since the rule alone would have early-returned above
              (P2b-1b). */}
          {defaultCollapsed && (
            <button
              type="button"
              className="change-set-card__collapse-toggle"
              aria-expanded={true}
              aria-label="Collapse"
              onClick={toggleCollapse}
            >
              Collapse
            </button>
          )}
        </>
      }
      footer={
        <div className="change-set-card__actions">
          {/* UXR-Q4: when this card's document/parse doesn't match the live editor field, every
              control below is disabled and this names the document the changes belong to — a visible,
              honest degraded state (never a silent no-op), so the user learns where to go rather than
              clicking a button that decides nothing (or, before this gate, the wrong text). */}
          {showMismatchBanner && (
            <p className="change-set-card__mismatch" role="status">
              {mismatchMessage}
            </p>
          )}
          <button type="button" onClick={enterReview} disabled={mismatch || pending.length === 0}>
            Review 1-by-1
          </button>
          <button type="button" onClick={() => decide(sweepIds, "accept")} disabled={mismatch || sweepIds.length === 0}>
            Accept all
          </button>
          <button type="button" onClick={() => decide(sweepIds, "reject")} disabled={mismatch || sweepIds.length === 0}>
            Reject all
          </button>
          <details
            className="change-set-card__overflow"
            ref={overflowRef}
            open={overflowOpen}
            onToggle={(event) => setOverflowOpen(event.currentTarget.open)}
          >
            <summary aria-label="More actions">⋯</summary>
            <div className="change-set-card__overflow-menu">
              {TYPE_FILTER_OPTIONS.map(({ filter, decision, label }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => {
                    decideByType(filter, decision);
                    setOverflowOpen(false);
                  }}
                  disabled={mismatch || typeFilterIds(filter).length === 0}
                >
                  {label}
                </button>
              ))}
            </div>
          </details>
        </div>
      }
    >
      <p className="change-set-card__summary">{card.summary}</p>
      {groupedByComment ? (
        <p className="change-set-card__counts">
          {card.changes.length} {card.changes.length === 1 ? "change" : "changes"} ·{" "}
          {card.replyCount ?? 0} {(card.replyCount ?? 0) === 1 ? "reply" : "replies"} ·{" "}
          {card.defenses?.length ?? 0} {(card.defenses?.length ?? 0) === 1 ? "defense" : "defenses"}
        </p>
      ) : (
        <p className="change-set-card__counts">
          {pending.length} {pending.length === 1 ? "change" : "changes"} · {sections.length}{" "}
          {sections.length === 1 ? "section" : "sections"}
        </p>
      )}
      {!mismatch && reachedChangeCount > 0 && (
        <p className="change-set-card__reach-note" role="status">
          ↳ also decided {reachedChangeCount} linked{" "}
          {reachedChangeCount === 1 ? "change" : "changes"} outside this set
        </p>
      )}
      {!mismatch && decidedElsewhereCount > 0 && (
        <p className="change-set-card__provenance-note" role="status">
          ↳ {decidedElsewhereCount} {decidedElsewhereCount === 1 ? "change" : "changes"} decided elsewhere
        </p>
      )}
      {groupedByComment ? (
        <ul className="change-set-card__comment-groups">
          {commentGroups.map((group) => (
            <li key={group.commentId}>
              <details className="change-set-card__comment-group" data-comment-id={group.commentId}>
                <summary>
                  {group.severity && <SeverityChip severity={group.severity} />} {group.label} (
                  {group.changes.length})
                </summary>
                {/* A group with nothing to decide yet (no change has been tied back to this
                    comment — J4 Batch, P2a-15) names the comment with no Accept/Reject controls at
                    all, rather than a pair that would only ever no-op. */}
                {group.changes.length > 0 && (
                  <div className="change-set-card__comment-group-actions">
                    <button
                      type="button"
                      onClick={() => decide(group.changes.map((change) => change.id), "accept")}
                      disabled={mismatch}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => decide(group.changes.map((change) => change.id), "reject")}
                      disabled={mismatch}
                    >
                      Reject
                    </button>
                  </div>
                )}
              </details>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="change-set-card__sections">
          {sections.map((section) => (
            <li key={section.name}>
              <details className="change-set-card__section" data-section={section.name}>
                <summary>
                  {section.name} <span className="change-set-card__section-count">({section.changes.length})</span>
                </summary>
                <div className="change-set-card__section-actions">
                  <button
                    type="button"
                    onClick={() => decide(section.changes.map((change) => change.id), "accept")}
                    disabled={mismatch}
                  >
                    Accept section
                  </button>
                  <button
                    type="button"
                    onClick={() => decide(section.changes.map((change) => change.id), "reject")}
                    disabled={mismatch}
                  >
                    Reject section
                  </button>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
      {/* Defenses (FR-CMT-4) are listed distinctly and carry no accept/reject controls at all —
          structurally excluded from Accept all/Reject all (which only ever decide `card.changes`)
          rather than filtered out of them by a special case. */}
      {card.defenses && card.defenses.length > 0 && (
        <ul className="change-set-card__defenses">
          {card.defenses.map((defense) => (
            <li key={defense.commentId} className="change-set-card__defense" data-comment-id={defense.commentId}>
              <span aria-hidden="true">⚑</span> defended: {defense.label}
            </li>
          ))}
        </ul>
      )}

      {currentChange && progress && (
        <div className="change-set-card__review">
          <p className="change-set-card__progress">
            {progress.position} of {progress.total}
          </p>
          <RedlinePopover
            change={{
              kind: currentChange.kind,
              oldText: currentChange.oldText ?? "",
              newText: currentChange.newText ?? "",
              note: currentChange.note,
            }}
            onAccept={() => decideCurrentAndAdvance("accept")}
            onReject={() => decideCurrentAndAdvance("reject")}
            onClose={exitReview}
          />
        </div>
      )}
    </TimelineCard>
  );
}
