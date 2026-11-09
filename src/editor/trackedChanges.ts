// ABOUTME: Interactive CriticMarkup redline model (P2a-5, FR-ED-4, TD-11 corollary) — a CM6
// ABOUTME: StateField seeding the backend's single parse snapshot, mapping each change's geometry
// ABOUTME: through edits by stable identity (never re-parse-then-index), rendering Word-style
// ABOUTME: redline, and routing accept/reject decisions as one undoable, group-atomic transaction.
import {
  Annotation,
  type ChangeDesc,
  EditorSelection,
  type EditorState,
  type Extension,
  Prec,
  type Range,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, type KeyBinding, keymap } from "@codemirror/view";
import { invertedEffects } from "@codemirror/commands";
import { KEYMAP } from "./keymap";
import {
  revealAtCursorEnabledField,
  setRevealAtCursorEnabled,
} from "./structuralDecorations";
import { decorationsEnabled, redlineResolution, viewModeChanged } from "./viewMode";

/** A half-open offset range in CodeMirror / JS-string (UTF-16) coordinates. */
export interface ChangeSpan {
  from: number;
  to: number;
}

/**
 * The identity half of one parsed change (`commands::changes::ChangePayload`, TD-16 rulings 2–3):
 * an **opaque string** `id` — the durable TD-4 `chg-<uuid>` where the marker joined an attribution
 * record, a snapshot-scoped `snap:<doc>:<generation>:<ordinal>` where it did not — plus which of
 * the two populations it belongs to. Never parse an `id` back into a number, compare it
 * numerically, or read it for its prefix: `recorded` is what says which population a change is in.
 */
interface ChangeIdentity {
  id: string;
  /** `true` when the backend vouches for this change (it joined a TD-4 record): `id` is durable
   * and `group` is authoritative. `false` for a human-typed marker, an imported file, or one whose
   * record no longer joins — identity is snapshot-scoped and grouping is this module's to infer. */
  recorded: boolean;
  /** The record's group (`grp-…`) this change decides all-or-none with. `null` means no backend
   * group: on a recorded change that is the backend asserting a singleton; on an unrecorded one it
   * is simply the absence of a record to assert anything. */
  group: string | null;
}

/**
 * One CriticMarkup change as the backend `parse_changes` command reports it (UTF-16 offsets —
 * `commands::changes::ChangePayload`). `kind` is the serde discriminator; the inner-segment span(s)
 * ride alongside it. This is the *snapshot* shape — geometry at parse time; the live field maps it
 * forward through edits (TD-11: stable identity, not a re-parse).
 */
export type ParsedChange = ChangeIdentity &
  (
    | { full: ChangeSpan; kind: "insertion"; text: ChangeSpan }
    | { full: ChangeSpan; kind: "deletion"; text: ChangeSpan }
    | { full: ChangeSpan; kind: "substitution"; old: ChangeSpan; new: ChangeSpan }
  );

/** Keep (`accept`) or discard (`reject`) a change — mirrors `textops::apply::Decision`. */
export type Decision = "accept" | "reject";

export type ChangeKind = "insertion" | "deletion" | "substitution";

/**
 * A live pending change: stable `id` from the snapshot, `groupId` linking co-members that must
 * decide all-or-none (`textops::apply::Grouping`), and the two redline sides as *current* mapped
 * spans — `underline` is the added side (kept on accept), `strike` the removed side (kept on
 * reject); either is absent for a pure insertion/deletion. Reading the resolution off the current
 * mapped span (not stored snapshot text) is what makes an edit *inside* a pending change win while
 * the change stays attributed (J1 Phase C edge state).
 */
export interface LiveChange {
  id: string;
  groupId: string;
  kind: ChangeKind;
  full: ChangeSpan;
  underline?: ChangeSpan;
  strike?: ChangeSpan;
  /** Optional agent note (from the delivery metadata, not the marker) shown in the popover. */
  note?: string;
}

/** Payload seeding the field from a fresh backend parse — plus optional grouping/notes overrides. */
export interface TrackedChangesSeed {
  changes: ParsedChange[];
  /**
   * Which parse this seed came from (UXR-Q4): the delivered document's revision for an agent
   * delivery, the on-disk revision for a document just opened, or `null`/omitted when the source
   * has no stable revision (e.g. a manual reload of an externally-changed file — which then
   * corresponds to no change-set card, and so fails triage closed). Stored in `changeGenerationField`
   * and compared against a change-set card's own `generation` before its ids may be decided, so a
   * card is never triaged against a field a *different* parse seeded (invariants 2 + 4).
   */
  generation?: string | null;
  /**
   * Extra group links (each inner array is a set of change ids decided together), applied *on top
   * of* the grouping the parse itself carries (see `seedToLiveChanges`) rather than instead of it —
   * a caller that knows about a link the parse cannot see adds it here. Ordinary seeds omit this:
   * since TD-16 the parse reports each change's own grouping, so there is nothing left for a
   * delivery to spell out.
   */
  groups?: string[][];
  /** Agent notes by change id (from the MCP delivery, if any). */
  notes?: Record<string, string>;
}

/** Seed (or replace) the whole snapshot — dispatched when a document opens or an agent delivers. */
export const seedTrackedChanges = StateEffect.define<TrackedChangesSeed>();

/** Drop resolved change ids from the live set — carried by the same transaction that applies the
 * accept/reject text edit, so the redline disappears in lockstep with the markup it decorated. */
export const dropTrackedChanges = StateEffect.define<string[]>();

/**
 * Re-adds changes to the live set — the undo-side counterpart of `dropTrackedChanges` (finding M9:
 * "sidecar state versioned alongside [the text], so editor text and attribution never desync").
 * Never dispatched directly by app code: `invertTrackedChangeEffects` below registers this as the
 * `@codemirror/commands` `invertedEffects` inversion of a decision transaction, so CM6's own
 * history mechanism attaches it to the popped undo transaction alongside the inverse text edit —
 * one undo, both the markup AND its attribution restored, never just one of the two. Its `map`
 * keeps the carried spans in sync with any edits between the decision and the eventual undo,
 * exactly as `trackedChangesField` keeps live changes in sync with edits during the forward
 * direction (`mapLiveChange`).
 */
export const restoreTrackedChanges = StateEffect.define<LiveChange[]>({
  map: (value, mapping) => value.map((c) => mapLiveChange(c, mapping)),
});

/** The position-bearing half of one live change. Formatting transactions use this explicit
 * post-edit geometry so Markdown markers inserted at a Critic boundary stay on the intended side
 * of that boundary without replacing the change's stable identity, group, kind, or note. */
export interface TrackedChangeGeometry {
  id: string;
  full: ChangeSpan;
  underline?: ChangeSpan;
  strike?: ChangeSpan;
}

/** Replace only the mapped spans of existing live changes. The effect is position-aware because
 * CM6 may map a stored undo effect through later document edits before it is dispatched. */
export const setTrackedChangeGeometry = StateEffect.define<readonly TrackedChangeGeometry[]>({
  map: (value, mapping) => value.map((geometry) => mapGeometry(geometry, mapping)),
});

/** `userEvent` tags on the decision transactions, so undo/history and tests can recognise them. */
export const ACCEPT_USER_EVENT = "redline.accept";
export const REJECT_USER_EVENT = "redline.reject";

/** The surface that produced a decision report consumed outside `editor/` (UXR-Q5). */
export type DecisionSource = "editor" | "card" | "redo";

/** Tags forward decision transactions with their originating surface. Redo is identified from
 * CM6's own `redo` user event because history deliberately does not preserve custom annotations. */
export const decisionSource = Annotation.define<Exclude<DecisionSource, "redo">>();

/** Turn a snapshot change into a live change (pre-grouping): split its segments into the redline
 * add/remove sides the decoration and resolution both read. */
function toLiveChange(change: ParsedChange): LiveChange {
  switch (change.kind) {
    case "insertion":
      return { id: change.id, groupId: change.id, kind: "insertion", full: change.full, underline: change.text };
    case "deletion":
      return { id: change.id, groupId: change.id, kind: "deletion", full: change.full, strike: change.text };
    case "substitution":
      return {
        id: change.id,
        groupId: change.id,
        kind: "substitution",
        full: change.full,
        strike: change.old,
        underline: change.new,
      };
  }
}

/** The grouping the *recorded* population carries intrinsically (TD-16 ruling 4): changes whose
 * records share a `group` (`grp-…`) decide together. A recorded change with `group: null` is the
 * backend positively asserting a singleton, so it forms no group here. */
function recordedGroups(changes: ParsedChange[]): string[][] {
  const byGroup = new Map<string, string[]>();
  for (const change of changes) {
    if (!change.recorded || change.group === null) continue;
    const members = byGroup.get(change.group);
    if (members) members.push(change.id);
    else byGroup.set(change.group, [change.id]);
  }
  return [...byGroup.values()];
}

/** The grouping the *unrecorded* population gets inferred (TD-16 ruling 4, P4b): every adjacent
 * deletion→insertion pair (`{--old--}{++new++}`) shares a group so the pair decides atomically.
 *
 * Both members must be unrecorded. A pair straddling the two populations is deliberately left
 * ungrouped: extending a backend group with a change the backend never recorded is the same defect
 * as inventing one (#566). The two rules therefore cover disjoint populations and cannot disagree. */
function autoGroups(changes: ParsedChange[]): string[][] {
  const groups: string[][] = [];
  for (let i = 0; i + 1 < changes.length; i++) {
    const del = changes[i];
    const ins = changes[i + 1];
    if (del.recorded || ins.recorded) continue;
    if (del.kind === "deletion" && ins.kind === "insertion" && del.full.to === ins.full.from) {
      groups.push([del.id, ins.id]);
    }
  }
  return groups;
}

/** Build the live set from a seed: apply grouping and attach notes.
 *
 * Grouping is a **partition, not an either/or** (TD-16 ruling 4): each population is grouped by its
 * own rule over its own members — recorded changes by the record's `group`, unrecorded ones by
 * adjacency among themselves — so `textops::apply::Grouping`'s disjointness holds by construction.
 * A caller's explicit `seed.groups` is applied last, on top of both. */
export function seedToLiveChanges(seed: TrackedChangesSeed): LiveChange[] {
  const live = seed.changes.map(toLiveChange);
  const byId = new Map(live.map((c) => [c.id, c]));
  // Document-order index per id, used only to pick a group's canonical member (below) — never to
  // compare or sort ids themselves, since an id is opaque (TD-16 ruling 1).
  const orderOf = new Map(seed.changes.map((c, i) => [c.id, i]));
  const groups = [...recordedGroups(seed.changes), ...autoGroups(seed.changes), ...(seed.groups ?? [])];
  for (const group of groups) {
    // The group's canonical id is its earliest member in document order, so the choice is
    // order-independent without assuming the opaque id is itself numerically comparable.
    const groupId = group.reduce((a, b) => ((orderOf.get(a) ?? 0) <= (orderOf.get(b) ?? 0) ? a : b));
    for (const id of group) {
      const c = byId.get(id);
      if (c) c.groupId = groupId;
    }
  }
  if (seed.notes) {
    for (const [id, note] of Object.entries(seed.notes)) {
      const c = byId.get(id);
      if (c) c.note = note;
    }
  }
  return live;
}

/** Map a span forward through a set of edits so it keeps covering the same logical text and
 * *grows* to include text typed at either boundary (an edit inside a pending change wins, J1).
 * Takes a `ChangeDesc`-shaped mapping (a `Transaction`'s `.changes` satisfies this, and so does
 * the mapping `invertedEffects`/history hands `restoreTrackedChanges.map` for an edit that
 * happened between a decision and its eventual undo) rather than a `Transaction` itself, so the
 * same function serves both the live forward path and the undo-side effect mapping. */
function mapSpan(span: ChangeSpan, mapping: ChangeDesc): ChangeSpan {
  return { from: mapping.mapPos(span.from, -1), to: mapping.mapPos(span.to, 1) };
}

function mapLiveChange(change: LiveChange, mapping: ChangeDesc): LiveChange {
  return {
    ...change,
    full: mapSpan(change.full, mapping),
    underline: change.underline && mapSpan(change.underline, mapping),
    strike: change.strike && mapSpan(change.strike, mapping),
  };
}

function geometryOf(change: LiveChange): TrackedChangeGeometry {
  return {
    id: change.id,
    full: change.full,
    underline: change.underline,
    strike: change.strike,
  };
}

function mapGeometry(
  geometry: TrackedChangeGeometry,
  mapping: ChangeDesc,
): TrackedChangeGeometry {
  return {
    id: geometry.id,
    full: mapSpan(geometry.full, mapping),
    underline: geometry.underline && mapSpan(geometry.underline, mapping),
    strike: geometry.strike && mapSpan(geometry.strike, mapping),
  };
}

/**
 * Geometry override for a source-format transaction. The full Critic span excludes syntax placed
 * exactly at either outer boundary, while an authored underline/strike span includes syntax placed
 * exactly at either inner boundary. That distinction is what makes formatting beside a pending
 * change external to Accept/Reject, and formatting inside its authored side survive the decision.
 */
export function formattingGeometryEffect(
  state: EditorState,
  mapping: ChangeDesc,
): StateEffect<readonly TrackedChangeGeometry[]> | null {
  const geometry = trackedChanges(state).map((change) => ({
    id: change.id,
    full: {
      from: mapping.mapPos(change.full.from, 1),
      to: mapping.mapPos(change.full.to, -1),
    },
    underline: change.underline && mapSpan(change.underline, mapping),
    strike: change.strike && mapSpan(change.strike, mapping),
  }));
  return geometry.length > 0 ? setTrackedChangeGeometry.of(geometry) : null;
}

/**
 * The live tracked-change set — a `StateField` (not a `ViewPlugin`) so it is exercised through
 * `EditorState.update` alone, testable without a mounted view. Unlike the structural-markdown layer
 * (`structuralDecorationsPlugin`, TD-13/SPIKE-3/#216), this list is never viewport-scoped: pending
 * changes must be navigable (`nextChange`/`prevChange`) and countable regardless of what's on screen,
 * so it stays a whole-document `StateField`. Seeded by `seedTrackedChanges`; every other transaction
 * maps surviving changes forward by their
 * stable identity and drops any the transaction resolved (`dropTrackedChanges`) — the doc is never
 * re-parsed here, which is exactly the TD-11 corollary the interactive path must honour.
 */
export const trackedChangesField = StateField.define<LiveChange[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(seedTrackedChanges)) return seedToLiveChanges(effect.value);
    }
    const dropped = new Set<string>();
    const restored: LiveChange[] = [];
    const geometry = new Map<string, TrackedChangeGeometry>();
    for (const effect of tr.effects) {
      if (effect.is(dropTrackedChanges)) for (const id of effect.value) dropped.add(id);
      if (effect.is(restoreTrackedChanges)) restored.push(...effect.value);
      if (effect.is(setTrackedChangeGeometry)) {
        for (const next of effect.value) geometry.set(next.id, next);
      }
    }
    if (!tr.docChanged && dropped.size === 0 && restored.length === 0 && geometry.size === 0) {
      return value;
    }
    let next = value.filter((c) => !dropped.has(c.id));
    if (tr.docChanged) next = next.map((c) => mapLiveChange(c, tr.changes));
    // `restored` (an undo's `restoreTrackedChanges` effect) is already valid in the resulting
    // `tr.state` doc — CM6's history keeps its stored effects mapped in lockstep with the inverse
    // text edit they ride alongside (see `restoreTrackedChanges`'s docs) — so it is appended after
    // this transaction's own doc-change mapping, never mapped by it a second time. Sorted back into
    // document order so navigation (`nextChange`/`prevChange`) stays correct after an undo.
    if (restored.length) {
      next = [...next, ...restored].sort((a, b) => a.full.from - b.full.from);
    }
    if (geometry.size > 0) {
      next = next.map((change) => {
        const replacement = geometry.get(change.id);
        return replacement
          ? {
              ...change,
              full: replacement.full,
              underline: replacement.underline,
              strike: replacement.strike,
            }
          : change;
      });
    }
    return next;
  },
});

/**
 * Which parse currently seeds the live tracked-change field — the UXR-Q4 correspondence token a
 * change-set card's ids must match before they may be decided (module docs on `TrackedChangesSeed.
 * generation`). Set by every `seedTrackedChanges` (a reseed replaces the whole field, and any
 * unrecorded change in it is re-identified against the new generation, so a card built against an
 * earlier one no longer corresponds) and preserved across every other
 * transaction — a decision drops/maps ids but never re-parses, so the surviving ids stay valid
 * against the same generation, which is exactly what lets the user triage a delivery one change at a
 * time without each accept invalidating the rest.
 */
export const changeGenerationField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(seedTrackedChanges)) return effect.value.generation ?? null;
    }
    return value;
  },
});

/** The generation token the live tracked-change field was last seeded with (UXR-Q4) — `null` before
 * any seed, or for a seed with no stable revision. A caller outside `editor/` reads this through
 * `EditorShellHandle.changeGeneration` rather than the field directly. */
export function changeGeneration(state: EditorState): string | null {
  return state.field(changeGenerationField, false) ?? null;
}

/**
 * The `invertedEffects` registration (`@codemirror/commands`) that makes a decision's
 * `dropTrackedChanges` undoable, in both directions:
 *   - inverting a **decision** transaction (carries `dropTrackedChanges`): looks up each dropped
 *     id's live shape in `tr.startState` (right before the decision) and stows it in a
 *     `restoreTrackedChanges` effect for CM6's history to attach to the eventual undo transaction.
 *   - inverting the **popped undo transaction itself** (carries `restoreTrackedChanges`): CM6's
 *     history re-inverts whatever transaction it just dispatched to build the matching redo entry
 *     (`historyField_`'s `fromHistory` branch), so this direction must produce a `dropTrackedChanges`
 *     of the same ids — otherwise a redo would reapply the text edit but leave the change sitting
 *     stale in the live set, pointing at text that no longer carries its markup.
 * Registering this costs nothing when `history()` isn't installed (the facet just goes unread).
 */
// @anchor:invert-tracked-change-effects
function invertTrackedChangeEffects(tr: Transaction): readonly StateEffect<unknown>[] {
  const out: StateEffect<unknown>[] = [];
  let restored: LiveChange[] | null = null;
  let redropped: string[] | null = null;
  let priorGeometry: TrackedChangeGeometry[] | null = null;
  for (const effect of tr.effects) {
    if (effect.is(dropTrackedChanges)) {
      const before = trackedChanges(tr.startState);
      for (const id of effect.value) {
        const change = before.find((c) => c.id === id);
        if (change) (restored ??= []).push(change);
      }
    } else if (effect.is(restoreTrackedChanges)) {
      (redropped ??= []).push(...effect.value.map((c) => c.id));
    } else if (effect.is(setTrackedChangeGeometry)) {
      const before = new Map(trackedChanges(tr.startState).map((change) => [change.id, change]));
      for (const geometry of effect.value) {
        const change = before.get(geometry.id);
        if (change) (priorGeometry ??= []).push(geometryOf(change));
      }
    }
  }
  if (restored) out.push(restoreTrackedChanges.of(restored));
  if (redropped) out.push(dropTrackedChanges.of(redropped));
  if (priorGeometry) out.push(setTrackedChangeGeometry.of(priorGeometry));
  return out;
}

/** Every live change, in document order. */
export function trackedChanges(state: EditorState): LiveChange[] {
  return state.field(trackedChangesField, false) ?? [];
}

/** Navigates to an existing live change by stable ID; stale IDs never select another change. */
export function focusTrackedChange(view: EditorView, changeId: string): boolean {
  const change = trackedChanges(view.state).find((candidate) => candidate.id === changeId);
  if (!change) return false;
  view.focus();
  view.dispatch({
    selection: EditorSelection.range(change.full.from, change.full.to),
    effects: EditorView.scrollIntoView(change.full.from, { y: "center" }),
  });
  return true;
}

/** The pending change whose full span contains `pos` (a click / cursor landing), or `undefined`.
 * Boundary-inclusive on the left, exclusive on the right — a click just past the marker misses it. */
export function changeAt(state: EditorState, pos: number): LiveChange | undefined {
  return trackedChanges(state).find((c) => pos >= c.full.from && pos < c.full.to);
}

/** The next change strictly after `pos` (wrapping to the first), or `undefined` when none exist. */
export function nextChange(state: EditorState, pos: number): LiveChange | undefined {
  const all = trackedChanges(state);
  return all.find((c) => c.full.from > pos) ?? all[0];
}

/** The previous change strictly before `pos` (wrapping to the last), or `undefined` when none. */
export function prevChange(state: EditorState, pos: number): LiveChange | undefined {
  const all = trackedChanges(state);
  for (let i = all.length - 1; i >= 0; i--) if (all[i].full.from < pos) return all[i];
  return all[all.length - 1];
}

/**
 * The text a live change resolves to under `decision`, read from the *current* document at the
 * mapped kept-side span — mirrors `textops::apply::resolution`:
 *   accept keeps the underlined (added) side, reject keeps the struck (removed) side; the other
 *   decision keeps nothing. Slicing the live span (not stored snapshot text) preserves any edit the
 *   user made inside the pending change (J1 "your edit wins").
 */
function resolutionText(state: EditorState, change: LiveChange, decision: Decision): string {
  const kept = decision === "accept" ? change.underline : change.strike;
  return kept ? state.doc.sliceString(kept.from, kept.to) : "";
}

/** Every live change sharing a group with any id in `ids` — the group-closure `decisionsTransaction`
 * sweeps together, factored out so it can be computed once and reused by both the transaction
 * builder below and a caller that needs the *members*, not just their ids. */
function groupClosureMembers(state: EditorState, ids: readonly string[]): LiveChange[] {
  const all = trackedChanges(state);
  const groupIds = new Set<string>();
  for (const id of ids) {
    const target = all.find((c) => c.id === id);
    if (target) groupIds.add(target.groupId);
  }
  return all.filter((c) => groupIds.has(c.groupId));
}

/**
 * The full id set `decisionsTransaction(state, ids, decision)` would decide — `ids` plus every
 * group co-member swept in (P4b) — computed without dispatching anything. Exported so a caller
 * outside this module that needs to report the *actual* decided set back across a module boundary
 * (`EditorShell`'s `decideChanges`, the timeline change-set card's `onDecide` seam, #410) doesn't
 * re-derive `decisionsTransaction`'s own group-closure logic a second time.
 */
// @anchor:decision-group-closure
export function decisionGroupClosure(state: EditorState, ids: readonly string[]): string[] {
  return groupClosureMembers(state, ids).map((c) => c.id);
}

/**
 * The single `TransactionSpec` that enacts `decision` on every id in `ids` and every co-member of
 * each one's group — all in one transaction, so it is one undo entry (finding M9, TD-2) and every
 * touched group decides all-or-none (P4b) from every UI entry point, single- or bulk-triggered
 * alike. `ids` need not already be group-closed (a bulk caller passes only the ids it matched; any
 * co-member missing from `ids` is swept in here) and duplicates collapse naturally. Returns `null`
 * if none of `ids` is a live change.
 *
 * *Scope note (CJ-ratified 2026-07-21, #416 — recorded in `docs/ux-design.md` §2: "Group closure is
 * not bounded by the change set … P4b carries no scope qualifier; this is P4b applied, not amended"):*
 * group membership here is a purely positional, document-level fact (`autoGroups`/`seedToLiveChanges`
 * above) — it carries no notion of which higher-level UI grouping (e.g. a timeline change-set card,
 * `timeline/ChangeSetCard.tsx`) a member's id was delivered under, and this function has no way to
 * know or care. So when a caller one layer up scopes `ids` to its own subset (a change-set card's
 * type filter scoped to that card's own changes, #416), a group that straddles that caller's scope
 * boundary still decides as one unit here — atomicity wins over any caller-side scope. That caller is
 * responsible for reconciling its *own* bookkeeping against whatever this function actually swept in
 * (`decisionGroupClosure` above reports the same closure without dispatching), not for narrowing
 * `ids` any further to try to keep a group split at the boundary.
 *
 * Never re-parses: it replaces each member's *mapped* `full` span with that member's resolution,
 * and tags the surviving-change bookkeeping via `dropTrackedChanges` — the TD-11-safe path, exactly
 * as true for a many-id bulk decision as for a single one (the live field is already a single-parse
 * snapshot mapped forward through edits, never re-derived from the document).
 */
export function decisionsTransaction(
  state: EditorState,
  ids: readonly string[],
  decision: Decision,
  source: Exclude<DecisionSource, "redo"> = "editor",
) {
  const members = groupClosureMembers(state, ids);
  if (members.length === 0) return null;
  const changes = members.map((c) => ({
    from: c.full.from,
    to: c.full.to,
    insert: resolutionText(state, c, decision),
  }));
  return {
    changes,
    effects: dropTrackedChanges.of(members.map((c) => c.id)),
    annotations: decisionSource.of(source),
    userEvent: decision === "accept" ? ACCEPT_USER_EVENT : REJECT_USER_EVENT,
  };
}

/** The single-id case of [`decisionsTransaction`] — enacts `decision` on `id` and every co-member
 * of its group, as one transaction. Returns `null` if `id` isn't a live change. */
export function decisionTransaction(state: EditorState, id: string, decision: Decision) {
  return decisionsTransaction(state, [id], decision);
}

/** Apply `decision` to change `id` (and its group) against `view`, as one undoable transaction.
 * Returns `true` if a change was decided; `onDecided` receives that exact transaction's mapping
 * after it dispatches. */
export function decideChange(
  view: EditorView,
  id: string,
  decision: Decision,
  onDecided?: (changes: ChangeDesc) => void,
): boolean {
  const spec = decisionTransaction(view.state, id, decision);
  if (!spec) return false;
  const transaction = view.state.update(spec);
  view.dispatch(transaction);
  onDecided?.(transaction.changes);
  return true;
}

/**
 * Which of the two J1-named types (J1-Q1: "Accept all insertions"/"Accept all deletions", and
 * reject equivalents) a type-filtered bulk op targets. A substitution (`kind === "substitution"`)
 * matches neither: J1 names only these two, so a type filter leaves a substitution's own change
 * untouched unless a group links it to a matching one (see [`decideByType`]).
 *
 * This module is the single home of that carve-out. A raw-markup/batch twin briefly existed in
 * `textops::apply` and was dropped on #393's review precisely because nothing called it: one rule
 * stated in two languages, with no mechanism keeping them in lockstep, is a drift risk bought for
 * nothing. Re-add the Rust form only alongside a real caller.
 */
export type ChangeTypeFilter = Extract<ChangeKind, "insertion" | "deletion">;

/** Every live change whose *own* kind matches `filter` — the type-filtered set before group
 * expansion. */
export function changesOfType(state: EditorState, filter: ChangeTypeFilter): LiveChange[] {
  return trackedChanges(state).filter((c) => c.kind === filter);
}

/**
 * Decide every live change of `filter`'s type with `decision`, in one transaction — the toolbar's
 * whole-document type-filtered bulk op (J1-Q1; the change-set card's own scoped equivalent decides
 * through its own `onDecide` id set, not this function). Group atomicity (P4b) comes for free from
 * `decisionsTransaction`: a change matching `filter` sweeps in every co-member of its group even
 * when that co-member's own kind doesn't match (the `{--old--}{++new++}` substitution-pair shape),
 * so a group is always decided as one unit, never split — the live-field analogue of
 * `textops::apply`'s own routing through `Grouping::decide`. Never re-parses (TD-11):
 * built entirely from the live, already-mapped snapshot. Returns `true` if anything was decided;
 * `onDecided` receives that exact transaction's mapping after it dispatches.
 */
export function decideByType(
  view: EditorView,
  filter: ChangeTypeFilter,
  decision: Decision,
  onDecided?: (changes: ChangeDesc) => void,
): boolean {
  const ids = changesOfType(view.state, filter).map((c) => c.id);
  const spec = decisionsTransaction(view.state, ids, decision);
  if (!spec) return false;
  const transaction = view.state.update(spec);
  view.dispatch(transaction);
  onDecided?.(transaction.changes);
  return true;
}

/** The change the caret is on — inside its span, or immediately after it (so a decision still fires
 * when the caret rests just past a change the user navigated to). `undefined` when the caret is on
 * no change. */
export function changeTouching(state: EditorState): LiveChange | undefined {
  const pos = state.selection.main.head;
  return changeAt(state, pos) ?? trackedChanges(state).find((c) => c.full.to === pos);
}

/** Decide the change under the caret — a keyboard command returning `false` (unhandled, so the
 * default binding runs) when the caret is on no change. */
function decideAtCursor(view: EditorView, decision: Decision): boolean {
  const change = changeTouching(view.state);
  if (!change) return false;
  return decideChange(view, change.id, decision);
}

/**
 * Platform-aware keyboard triage (FR-X-1, J1 Phase C): `Mod-Enter` accepts and `Mod-Backspace`
 * rejects the change under the caret — `Mod` is Cmd on macOS, Ctrl on Windows/Linux (CodeMirror
 * resolves it per platform). Both route through the one `decideChange` path the popover and toolbar
 * use. Each binding yields to the default when the caret is on no change (so `Mod-Backspace` still
 * deletes normally away from a redline). Key specs come from `editor/keymap.ts` (P2b-9b, #362) — the
 * single place this app's Cmd/Ctrl bindings are defined.
 */
export const redlineKeymap: readonly KeyBinding[] = [
  // No explicit `preventDefault`: CodeMirror already prevents default when a command returns true
  // (a change was decided); leaving it off lets the binding fall through cleanly when it returns
  // false (caret on no change), so `Mod-Backspace` still deletes normally there.
  { key: KEYMAP.acceptChange.spec, run: (view) => decideAtCursor(view, "accept") },
  { key: KEYMAP.rejectChange.spec, run: (view) => decideAtCursor(view, "reject") },
];

// --- decorations -----------------------------------------------------------

const INSERT = Decoration.mark({ class: "cm-redlineInsert" });
const DELETE = Decoration.mark({ class: "cm-redlineDelete" });
const PARAGRAPH = Decoration.line({ class: "cm-redlineParagraph" });
// Reuse the structural layer's hidden/revealed classes (one CSS source, one reveal animation) so a
// CriticMarkup delimiter hides and reveal-at-cursor exactly like a markdown marker (P2a-4/§3.3).
const HIDDEN = Decoration.mark({ class: "cm-markupHidden", attributes: { "aria-hidden": "true" } });
const REVEALED = Decoration.mark({ class: "cm-markupRevealed" });

/**
 * The delimiter (brace) spans of a change — everything inside `full` that isn't an inner segment:
 * the opener, the `~>` between a substitution's sides, and the closer.
 *
 * Exported because it is exactly the "markup scaffolding, not prose" partition two layers need:
 * this module hides/reveals it, and `spellcheck.ts` suppresses the webview's native spellchecker
 * over it. The complement (the inner `underline`/`strike` segments) is real prose the user will
 * accept or keep, so it stays checked — deriving both sides from this one function is what keeps
 * that boundary from being stated twice and drifting.
 */
export function delimiterSpans(change: LiveChange): ChangeSpan[] {
  const inner = [change.strike, change.underline]
    .filter((s): s is ChangeSpan => s !== undefined)
    .sort((a, b) => a.from - b.from);
  const spans: ChangeSpan[] = [];
  let cursor = change.full.from;
  for (const seg of inner) {
    if (seg.from > cursor) spans.push({ from: cursor, to: seg.from });
    cursor = seg.to;
  }
  if (change.full.to > cursor) spans.push({ from: cursor, to: change.full.to });
  return spans;
}

/** The line number the caret sits on — the reveal-at-cursor trigger (matches structuralDecorations). */
function activeLine(state: EditorState): number {
  return state.doc.lineAt(state.selection.main.head).number;
}

/** Both redline decoration sets from one pass: `view` is everything rendered (redline sides +
 * hidden/revealed delimiters); `hidden` is the strict subset of collapsed delimiter spans that
 * `EditorView.atomicRanges` must treat as one cursor-motion unit (so arrow keys skip hidden braces,
 * exactly as P2a-4 does for markdown markers).
 *
 * Gated by the P2a-8 view-mode state (never a doc mutation, purely which decorations this pass
 * emits): source view (`decorationsEnabled`) suppresses everything — raw CriticMarkup shown
 * verbatim, exactly like source view does for structural markup. Otherwise `redlineResolution`
 * picks how each change's two sides render: `"normal"` (All) keeps today's both-sides-colored
 * behavior; `"accept"` (Simple/None) hides the struck side entirely and renders the underlined side
 * as plain text — the "clean accept-all" reading `textops::display::project` computes; `"reject"`
 * (Original) is the mirror image. Either resolved mode also force-hides the delimiters regardless of
 * cursor position (a "clean reading" projection has no braces to reveal).
 */
function buildRedline(state: EditorState): { view: Range<Decoration>[]; hidden: Range<Decoration>[] } {
  if (!decorationsEnabled(state)) return { view: [], hidden: [] };
  const resolution = redlineResolution(state);
  const revealEnabled = resolution === "normal" && (state.field(revealAtCursorEnabledField, false) ?? true);
  const hideStrike = resolution === "accept"; // deleted text erased from a clean/accept-all read
  const hideUnderline = resolution === "reject"; // inserted text erased from an original/reject-all read
  const line = activeLine(state);
  const view: Range<Decoration>[] = [];
  const hidden: Range<Decoration>[] = [];
  for (const change of trackedChanges(state)) {
    // A whole-line insertion is the paragraph-level state drawn with an amber rule and ordinary
    // body text. Classify from live mapped geometry so a partial edit removes the block rule.
    // Deletions/substitutions keep their inline redline semantics until a distinct block treatment
    // for those kinds is specified.
    const paragraphLine = state.doc.lineAt(change.full.from);
    const paragraphInsertion = resolution === "normal"
      && change.kind === "insertion"
      && change.full.from < change.full.to
      && change.full.from === paragraphLine.from
      && change.full.to === paragraphLine.to;
    if (paragraphInsertion) view.push(PARAGRAPH.range(paragraphLine.from));
    if (change.strike && change.strike.to > change.strike.from) {
      if (hideStrike) {
        const r = HIDDEN.range(change.strike.from, change.strike.to);
        view.push(r);
        hidden.push(r);
      } else if (resolution === "normal") {
        view.push(DELETE.range(change.strike.from, change.strike.to));
      }
      // resolution === "reject": the struck side is the surviving (original) text — plain, no mark.
    }
    if (change.underline && change.underline.to > change.underline.from) {
      if (hideUnderline) {
        const r = HIDDEN.range(change.underline.from, change.underline.to);
        view.push(r);
        hidden.push(r);
      } else if (resolution === "normal" && !paragraphInsertion) {
        view.push(INSERT.range(change.underline.from, change.underline.to));
      }
      // resolution === "accept": the underlined side is the surviving (accepted) text — plain, no mark.
    }
    for (const span of delimiterSpans(change)) {
      if (span.to <= span.from) continue;
      const active = revealEnabled && state.doc.lineAt(span.from).number === line;
      if (active) {
        view.push(REVEALED.range(span.from, span.to));
      } else {
        const r = HIDDEN.range(span.from, span.to);
        view.push(r);
        hidden.push(r);
      }
    }
  }
  // CM6 requires decorations sorted by `from` (and `startSide`); marks over disjoint spans sort by
  // `from` alone.
  view.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide);
  hidden.sort((a, b) => a.from - b.from);
  return { view, hidden };
}

interface RedlineDecorationState {
  view: DecorationSet;
  atomic: DecorationSet;
}

function computeRedlineDecorations(state: EditorState): RedlineDecorationState {
  const { view, hidden } = buildRedline(state);
  return { view: Decoration.set(view, true), atomic: Decoration.set(hidden, true) };
}

/**
 * Whether `tr` carries a `seedTrackedChanges`/`dropTrackedChanges` effect or a view-mode switch —
 * every effect-only (no doc/selection change) reason the redline chrome must still refresh. Exported
 * so `EditorShell`'s own React-chrome bump reuses this exact list rather than keeping a second copy
 * that could silently drift from this module's (the effects that matter to the redline decorations
 * *are* the effects that matter to the toolbar reading them).
 */
export function redlineChromeEffectsChanged(tr: { effects: readonly StateEffect<unknown>[] }): boolean {
  return tr.effects.some((e) => e.is(seedTrackedChanges) || e.is(dropTrackedChanges)) || viewModeChanged(tr);
}

/** Whether a transaction could change the redline decorations — a doc edit, a seed/drop of changes,
 * an active-line move, or a reveal-suppression toggle. Anything else (same-line cursor nudge with
 * no pending change nearby) reuses the previous set. */
function redlineInputsChanged(tr: Transaction): boolean {
  return (
    tr.docChanged
    || activeLine(tr.startState) !== activeLine(tr.state)
    || redlineChromeEffectsChanged(tr)
    || tr.effects.some((effect) => effect.is(setRevealAtCursorEnabled))
  );
}

/** The redline decoration layer: hidden/revealed delimiters + green-underline/red-strike sides,
 * recomputed only when `redlineInputsChanged`. Kept beside the atomic-delimiter set (one pass). */
export const redlineDecorationsField = StateField.define<RedlineDecorationState>({
  create: (state) => computeRedlineDecorations(state),
  update(value, tr) {
    if (!redlineInputsChanged(tr)) return value;
    return computeRedlineDecorations(tr.state);
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.view),
});

export const redlineTheme = EditorView.baseTheme({
  ".cm-redlineInsert": {
    color: "var(--color-redline-insert-fg)",
    backgroundColor: "var(--color-redline-insert-bg)",
    borderBottom: "2px solid var(--color-redline-insert-border)",
  },
  ".cm-redlineParagraph": {
    paddingLeft: "14px",
    borderLeft: "3px solid var(--color-redline-paragraph-border)",
  },
  ".cm-redlineDelete": {
    color: "var(--color-redline-delete-fg)",
    textDecoration: "line-through",
    textDecorationColor: "var(--color-redline-delete-fg)",
  },
});

/** The tracked-change/redline extension bundle the editor wires into a document's state: the live
 * change field, the redline decorations, their atomic hidden-delimiter ranges, and the CSS. Reveal-
 * at-cursor suppression rides `revealAtCursorEnabledField`, already installed by the structural
 * layer, so redline and markdown markers reveal together. */
export function redlineExtensions(): Extension[] {
  return [
    trackedChangesField,
    changeGenerationField,
    redlineDecorationsField,
    EditorView.atomicRanges.of((view) => view.state.field(redlineDecorationsField).atomic),
    // `Prec.high` so triage wins over the default `Mod-Backspace`/`Mod-Enter` bindings when the
    // caret is on a change; each binding falls through (returns false) otherwise.
    Prec.high(keymap.of([...redlineKeymap])),
    redlineTheme,
    // Makes decision bookkeeping and format-geometry overrides part of CM6's own undo history — a
    // no-op unless `history()` is also installed.
    invertedEffects.of(invertTrackedChangeEffects),
  ];
}
