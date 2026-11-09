// ABOUTME: Tab display state (P2a-6, TD §3.1 "stores/ ... tabs ... display state only; all
// ABOUTME: authority lives in Rust") — open/switch/close transitions, dirty tracking, the
// ABOUTME: dirty-close guard predicate (FR-ED-3), and mapping to/from the persisted session shape.
import type { SessionPayload } from "../editor/ipc";
import { ancestorsOf, movedPath, type ProjectFileMove } from "./project";

/** One open tab: its identity (`path`) and whether it currently differs from disk. */
export interface TabRecord {
  path: string;
  // @anchor:tab-record-dirty
  dirty: boolean;
  /** Stable TD-4 identity while this tab has no project path (#1803). */
  docId?: string;
  /** In-process J12 surface identity retained across scratch Save As; never session-persisted. */
  surfaceIdentity?: string;
  adoptedDisplacedPath?: string;
  /**
   * Present only on an untitled recovery document, naming its former project path: displaced by a
   * move (#932) or refused at legacy restore because its type is unsupported (#2515). Its
   * presence — not the spelling of `path` — is what makes this tab "not a
   * project document" for every consumer: what it renders, whether it joins D21's protected set,
   * whether the shell reports a project document as active, and whether closing it is guarded.
   *
   * The discriminator is a field rather than a path prefix because any string that survives §3.5
   * confinement is by construction a possible project-relative path (CJ, 2026-08-12): a document
   * legitimately named `untitled:1:notes.md` is an ordinary project document, and sniffing the
   * path for a prefix would have dropped it out of the protected set.
   */
  recoveredFrom?: string;
  /**
   * A persisted 2 MiB omission fact (#1421), including an older omission beside retained current
   * text. Only a recovery document presents J2's standing 9c state, but an ordinary restored tab
   * must carry the fact through its next checkpoint and any D27 conversion.
   */
  recoveryContentOmitted?: boolean;
  /** An explicit current empty buffer can coexist with an earlier omission; null means no buffer. */
  retainedEmptyContent?: boolean;
  /** Whether the standing over-cap explanation is collapsed to its persistent one-line form. */
  lossNoticeCollapsed?: boolean;
  /** Stable creation-order disambiguator for repeated displacement of the same project path. */
  displacedLabelOrdinal?: number;
}

/** Whether `tab` is an untitled recovery document rather than a document in the project. Narrows
 * `recoveredFrom` so a caller that needs the displaced path reads it off the same check, rather
 * than testing the field itself and spelling the concept a second way. */
export function isRecoveredTab(tab: TabRecord): tab is TabRecord & { recoveredFrom: string } {
  return tab.recoveredFrom !== undefined;
}

/** The whole open-tab set for one project, plus which tab (if any) is active. */
export interface TabsState {
  tabs: TabRecord[];
  activePath: string | null;
}

/** No project open yet, or a project with no tabs. */
export const EMPTY_TABS: TabsState = { tabs: [], activePath: null };

/**
 * The identity an untitled recovery document is keyed by: `untitled:<n>:<the path it was displaced
 * from>` (CJ, 2026-08-11; J2 "rail lifecycle"). A confidently correlated move can land on a path
 * another open document occupies — the moved document then becomes the sole document at that path,
 * and the displaced one no longer has a file. A displaced document with unsaved work keeps that
 * work under this identity rather than losing it.
 *
 * This is an *identity only*, never a discriminator: what makes a tab a recovery document is its
 * `recoveredFrom` field (CJ, 2026-08-12), because a document legitimately named `untitled:1:b.md`
 * would otherwise be misclassified out of D21's protected set. Nothing parses this string, and
 * nothing but uniqueness among the open tabs is required of it — the `<n>` is what makes a second
 * displacement of one path a second document rather than a collision with the first, and the
 * displaced path is kept in it only so a session file stays legible to a human reading it.
 *
 * It never reaches the filesystem: nothing opens, saves, watches, or protects it (`TabbedEditor`
 * renders it from the buffer alone and leaves it out of the backend's open-tab set).
 */
const RECOVERED_DOCUMENT_PREFIX = "untitled:";

/** Mirrors Rust's `UNSAVED_CONTENT_CAP_BYTES`; UTF-8 bytes, not UTF-16 code units. */
// @anchor:session-unsaved-content-cap-ts
export const SESSION_UNSAVED_CONTENT_CAP_BYTES = 2 * 1024 * 1024;

/** Whether the live untitled buffer cannot fit in the next session snapshot. */
// @anchor:exceeds-session-content-cap-fn
export function exceedsSessionContentCap(content: string): boolean {
  return new TextEncoder().encode(content).byteLength > SESSION_UNSAVED_CONTENT_CAP_BYTES;
}

/** What the tab strip calls a tab: its project path, or a recovery document's own description of
 * itself (its identity is machinery, and reading `untitled:1:…` off the strip is not). */
export function tabLabel(tab: TabRecord, openTabs?: readonly TabRecord[]): string {
  if (tab.recoveredFrom === undefined) return tab.path;
  const collides = openTabs?.filter(
    (candidate) => candidate.recoveredFrom === tab.recoveredFrom,
  ).length ?? 0;
  const ordinal = collides > 1 && tab.displacedLabelOrdinal !== undefined
    ? ` (${tab.displacedLabelOrdinal})`
    : "";
  return `Untitled — recovered from ${tab.recoveredFrom}${ordinal}`;
}

function recoveredDocumentIdentity(displaced: string, taken: Set<string>): string {
  for (let n = 1; ; n += 1) {
    const candidate = `${RECOVERED_DOCUMENT_PREFIX}${n}:${displaced}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function indexOf(state: TabsState, path: string): number {
  return state.tabs.findIndex((t) => t.path === path);
}

/**
 * Opens `path` as a tab: if it's already open, this just focuses it (never duplicates the tab or
 * resets its dirty flag); otherwise a fresh, clean tab is appended and focused. This is what makes
 * "open a second file" add a second tab rather than replace the first (FR-ED-3).
 */
export function openTab(state: TabsState, path: string): TabsState {
  if (indexOf(state, path) >= 0) {
    return state.activePath === path ? state : { ...state, activePath: path };
  }
  return { tabs: [...state.tabs, { path, dirty: false }], activePath: path };
}

/** Focuses an already-open tab; a no-op (same reference back) if `path` isn't open. */
export function setActiveTab(state: TabsState, path: string): TabsState {
  if (indexOf(state, path) < 0 || state.activePath === path) return state;
  return { ...state, activePath: path };
}

/** Marks `path`'s tab dirty/clean; a no-op if `path` isn't open. */
export function setTabDirty(state: TabsState, path: string, dirty: boolean): TabsState {
  const i = indexOf(state, path);
  if (i < 0 || state.tabs[i].dirty === dirty) return state;
  const tabs = [...state.tabs];
  tabs[i] = { ...tabs[i], dirty };
  return { ...state, tabs };
}

/** Once an author explicitly edits an omitted recovery buffer to empty, keep that empty text. */
export function retainEmptyRecoveryContent(state: TabsState, path: string): TabsState {
  const i = indexOf(state, path);
  const tab = state.tabs[i];
  if (i < 0 || !isRecoveredTab(tab) || !tab.recoveryContentOmitted || tab.retainedEmptyContent) {
    return state;
  }
  const tabs = [...state.tabs];
  tabs[i] = { ...tab, retainedEmptyContent: true };
  return { ...state, tabs };
}

/** Records the backend-minted identity for an untitled tab exactly once. */
export function setUntitledDocId(state: TabsState, path: string, docId: string): TabsState {
  const i = indexOf(state, path);
  const tab = state.tabs[i];
  if (i < 0 || !isRecoveredTab(tab) || tab.docId !== undefined || docId.length === 0) return state;
  const tabs = [...state.tabs];
  tabs[i] = { ...tab, docId };
  return { ...state, tabs };
}

/** Persists the author's presentation choice for the standing over-cap recovery notice. */
export function setRecoveryNoticeCollapsed(
  state: TabsState,
  path: string,
  collapsed: boolean,
): TabsState {
  const i = indexOf(state, path);
  const tab = state.tabs[i];
  if (
    i < 0 ||
    !isRecoveredTab(tab) ||
    tab.recoveryContentOmitted !== true ||
    (tab.lossNoticeCollapsed ?? false) === collapsed
  ) {
    return state;
  }
  const tabs = [...state.tabs];
  tabs[i] = { ...tab, ...(collapsed ? { lossNoticeCollapsed: true } : {}) };
  if (!collapsed) delete tabs[i].lossNoticeCollapsed;
  return { ...state, tabs };
}

/**
 * Removes `path`'s tab unconditionally — callers must have already resolved any dirty-close guard
 * (`dirtyTabsRequiringGuard`); this does not itself check `dirty`. Closing the active tab focuses
 * its right neighbor, falling back to its left neighbor, falling back to no active tab at all —
 * the conventional tab-strip "close" behavior. A no-op if `path` isn't open.
 */
export function closeTab(state: TabsState, path: string): TabsState {
  const closedIndex = indexOf(state, path);
  if (closedIndex < 0) return state;

  const tabs = state.tabs.filter((t) => t.path !== path);
  if (state.activePath !== path) {
    return { tabs, activePath: state.activePath };
  }
  const neighbor = tabs[closedIndex] ?? tabs[closedIndex - 1];
  return { tabs, activePath: neighbor ? neighbor.path : null };
}

/**
 * Turns an untitled recovery tab into an ordinary project tab once its buffer has actually been
 * written into the project (D12, FR-ED-8 "a scratch doc saved into the project adopts any
 * comments/changes accumulated while untitled") — completing the editable scratch-document
 * lifecycle established by #1379 and wired to UUID sidecars by #1803.
 *
 * Deliberately its own transition rather than a `rekeyTabPaths` call: that function preserves every
 * other field of a moved tab (`{ ...tab, path: to }`), which is exactly wrong here — a tab that
 * *was* `recoveredFrom` must not still read as one once it has a real project path, or it would stay
 * misclassified out of D21's protected set and the rail forever. `dirty: false` matches every other
 * freshly-saved tab (the write that just landed *is* the saved content).
 *
 * A no-op (same reference back) unless `at` names an open tab that is currently an untitled
 * recovery document — an ordinary project tab is never "adopted" by this function, which is what
 * keeps a plain Save As from being mistaken for scratch-doc adoption.
 *
 * Also a no-op when `savedPath` already names a *different* open tab: every sibling transition in
 * this store guards a destination collision (`openTab` never duplicates a tab; `rekeyTabPaths`
 * displaces the occupant explicitly) rather than letting two tabs share one path. Two tabs at the
 * same path is not a cosmetic glitch here — `paneKeyFor` (`TabbedEditor`) keys both panes off the
 * path alone, so the second tab would render the first tab's pane and could never be selected,
 * closed, or marked dirty on its own. The caller is responsible for having already written the
 * bytes (or refused to) before calling this; this only protects the tab-state bookkeeping.
 */
export function adoptUntitledTab(state: TabsState, at: string, savedPath: string): TabsState {
  const i = indexOf(state, at);
  if (i < 0 || !isRecoveredTab(state.tabs[i])) return state;
  if (state.tabs.some((tab, index) => index !== i && tab.path === savedPath)) return state;
  const tabs = [...state.tabs];
  const recovered = state.tabs[i];
  tabs[i] = {
    path: savedPath,
    dirty: false,
    docId: recovered.docId,
    surfaceIdentity: recovered.path,
    adoptedDisplacedPath: recovered.recoveredFrom,
  };
  const activePath = state.activePath === at ? savedPath : state.activePath;
  return { tabs, activePath };
}

/**
 * Follows TD-18's confidently correlated external path transitions (#932): every open tab the
 * backend proved moved keeps its place in the strip, its dirty flag, and — if it was the active one
 * — the active marker, now under its new path. The same state reference comes back when no open tab
 * moved, so a generation full of transitions elsewhere in the project costs no tab churn.
 *
 * `movedPath`'s exact lookup is deliberate: a descendant of a moved directory whose own identity the
 * backend could not prove is *not* rekeyed here. Its tab stays on the old path, which is the honest
 * state — that document has not been shown to be the same one — and is what hands it to the
 * dependent Missing-on-disk lifecycle rather than silently repointing a buffer at another file.
 *
 * A destination that collides with an already-open tab keeps only the moved tab at that path: the
 * colliding path now names the moved document, so two tabs claiming it would be two views of one
 * file. What becomes of the *displaced* document is `recoveredTabPaths` below — a clean one's tab
 * closes, a dirty one's buffer stays open as an untitled recovery document (CJ, 2026-08-11).
 */
export function rekeyTabPaths(
  state: TabsState,
  moves: readonly ProjectFileMove[],
): TabsState {
  const destinations = destinationsFor(state, moves);
  if (destinations.size === 0) return state;

  const claimed = new Set(destinations.values());
  const recovered = new Map(recoveredTabPaths(state, moves).map((entry) => [entry.from, entry]));
  const tabs = state.tabs
    .filter(
      (tab) => destinations.has(tab.path) || !claimed.has(tab.path) || recovered.has(tab.path),
    )
    .map((tab) => {
      const to = destinations.get(tab.path);
      if (to !== undefined) return { ...tab, path: to };
      const recovery = recovered.get(tab.path);
      if (recovery === undefined) return tab;
      // A recovery document is never `dirty`: that flag means "this buffer differs from its file",
      // and drives FR-ED-3's save guard — which has nothing to save this one *to*. Its whole
      // buffer is durable through the session instead (`toSessionPayload`), and its close is
      // guarded on `recoveredFrom` rather than on `dirty` (`tabsRequiringCloseGuard`).
      return {
        path: recovery.to,
        dirty: false,
        recoveredFrom: tab.path,
        displacedLabelOrdinal: recovery.displacedLabelOrdinal,
      };
    });
  const activePath =
    state.activePath === null
      ? null
      : destinations.get(state.activePath) ??
        recovered.get(state.activePath)?.to ??
        state.activePath;
  return { tabs, activePath };
}

/**
 * The untitled recovery identity each *displaced* open tab keeps its unsaved buffer under when a
 * move lands on its path (CJ, 2026-08-11): the moved document becomes the sole document at that
 * path, so a displaced document with unsaved work needs somewhere to be that is not that path and
 * is not the file it no longer has. A displaced tab with nothing unsaved is absent — it has nothing
 * to preserve, so its tab simply closes.
 *
 * Exported because the tab layer must carry those buffers to exactly the identities `rekeyTabPaths`
 * mints; both read the same plan from the same inputs rather than each deriving its own.
 */
export function recoveredTabPaths(
  state: TabsState,
  moves: readonly ProjectFileMove[],
): { from: string; to: string; displacedLabelOrdinal: number }[] {
  const destinations = destinationsFor(state, moves);
  if (destinations.size === 0) return [];

  const claimed = new Set(destinations.values());
  const taken = new Set([...state.tabs.map((tab) => tab.path), ...claimed]);
  const recovered: { from: string; to: string; displacedLabelOrdinal: number }[] = [];
  for (const tab of state.tabs) {
    // Displaced: this tab's own identity did not move, and a moved document now claims its path.
    if (destinations.has(tab.path) || !claimed.has(tab.path) || !tab.dirty) continue;
    const to = recoveredDocumentIdentity(tab.path, taken);
    const displacedLabelOrdinal = Math.max(
      0,
      ...state.tabs
        .filter((candidate) => candidate.recoveredFrom === tab.path)
        .map((candidate) => candidate.displacedLabelOrdinal ?? 0),
      ...recovered
        .filter((candidate) => candidate.from === tab.path)
        .map((candidate) => candidate.displacedLabelOrdinal),
    ) + 1;
    taken.add(to);
    recovered.push({ from: tab.path, to, displacedLabelOrdinal });
  }
  return recovered;
}

/** A restored document whose type is no longer supported cannot keep its old file identity. Its
 * retained edit becomes an untitled document, using the same session and Save As lifecycle as a
 * document displaced by a correlated move. A tab without retained work is handled separately. */
export function recoverUnsupportedTab(state: TabsState, path: string): TabsState {
  const index = indexOf(state, path);
  if (index < 0 || !state.tabs[index].dirty || isRecoveredTab(state.tabs[index])) return state;
  const identity = recoveredDocumentIdentity(path, new Set(state.tabs.map((tab) => tab.path)));
  const displacedLabelOrdinal = Math.max(
    0,
    ...state.tabs
      .filter((tab) => tab.recoveredFrom === path)
      .map((tab) => tab.displacedLabelOrdinal ?? 0),
  ) + 1;
  const tabs = [...state.tabs];
  tabs[index] = {
    path: identity,
    dirty: false,
    recoveredFrom: path,
    displacedLabelOrdinal,
    ...(state.tabs[index].recoveryContentOmitted ? { recoveryContentOmitted: true } : {}),
    ...(state.tabs[index].retainedEmptyContent ? { retainedEmptyContent: true } : {}),
  };
  return {
    tabs,
    activePath: state.activePath === path ? identity : state.activePath,
  };
}

/** Each open tab that TD-18 proved moved, paired with the path it moved to. */
function destinationsFor(
  state: TabsState,
  moves: readonly ProjectFileMove[],
): Map<string, string> {
  const destinations = new Map<string, string>();
  for (const tab of state.tabs) {
    const to = movedPath(tab.path, moves);
    if (to !== null) destinations.set(tab.path, to);
  }
  return destinations;
}

/**
 * Which open tabs a completed generation proves have no file at their path any more — J2's
 * **Missing on disk** set (#933), evaluated against `presentFilePaths` of that same generation
 * *after* its proven moves have been followed (`rekeyTabPaths`), so a document that merely moved is
 * never reported missing.
 *
 * Absence alone is not that proof, because a completed generation does not enumerate the whole
 * project: `undescended` (of the same generation) names the rows it listed without walking beneath
 * them, and a document under one of those is unenumerated rather than missing. Only the row's own
 * path is still judged on presence — if the document's path is now an unreadable folder, its file
 * is not there.
 *
 * An untitled recovery document is never in it: it is at no project path by construction, so the
 * project tree can say nothing about it (its own displacement is already recorded on the tab).
 *
 * Recomputed from each generation rather than accumulated, so a path that appears again is simply
 * absent from the next result — reappearance needs no separate clearing rule.
 */
export function missingTabPaths(
  state: TabsState,
  present: ReadonlySet<string>,
  undescended: ReadonlySet<string>,
): string[] {
  return state.tabs
    .filter(
      (tab) =>
        !isRecoveredTab(tab) &&
        !present.has(tab.path) &&
        !ancestorsOf(tab.path).some((ancestor) => undescended.has(ancestor)),
    )
    .map((tab) => tab.path);
}

/**
 * Which of `paths` (default: every open tab — the "quit with dirty tabs open" case) are dirty and
 * therefore need a save/discard/cancel decision before *quitting* (FR-ED-3's dirty-close guard).
 * Pure predicate: callers own presenting the guard UI and applying its decision.
 *
 * A recovery document is deliberately absent from this legacy dirty-tab predicate. J2 now permits
 * an unguarded quit only after the Architect-owned final session write returns authoritative
 * losslessness proof; live over-cap recovery content must join its specialized guard instead. This
 * predicate remains only the dirty project-document queue until that proof-aware coordinator owns
 * both categories. Closing one tab is independently guarded by `tabsRequiringCloseGuard` below.
 */
export function dirtyTabsRequiringGuard(state: TabsState, paths?: string[]): string[] {
  const targets = paths ?? state.tabs.map((t) => t.path);
  return state.tabs.filter((t) => targets.includes(t.path) && t.dirty).map((t) => t.path);
}

/**
 * Which of `paths` need a decision before their tab is *closed*: the dirty ones as ever, plus every
 * untitled recovery document (J2, CJ 2026-08-12). Closing a preserved recovery tab destroys the
 * session's only copy; closing an over-cap one clears the only surviving record of what happened.
 * Both are standing recovery states and require the specialized three-action guard, even though
 * the tab is never `dirty`.
 *
 * The guard's action depends on the tab: an untitled recovery document offers its ratified Save As
 * adoption route, while a dirty project document offers Save. Cancellation preserves either buffer;
 * only explicit Discard destroys it.
 */
export function tabsRequiringCloseGuard(state: TabsState, paths: string[]): string[] {
  return state.tabs
    .filter((t) => paths.includes(t.path) && (t.dirty || isRecoveredTab(t)))
    .map((t) => t.path);
}

/**
 * Rebuilds tab display state from a loaded `SessionPayload` (`store::tab_session`, P2a-6): each
 * persisted tab reopens, dirty exactly when it carried capped unsaved content — except an untitled
 * recovery document (the tab whose snapshot carries `recoveredFrom`, never one whose path merely
 * looks like an identity), whose content *is* the document rather than a divergence from a file, so
 * it comes back exactly as it was left: open, holding its buffer, and not dirty. The saved active
 * path is honored only if it's actually among the restored tabs — a session file that outlived a
 * since-closed tab (hand-edited, or a future schema migration) falls back to the first tab rather
 * than pointing at nothing.
 *
 * The explicit `unsavedContentOmitted` outcome drives the standing over-cap state. Rust owns the
 * one bounded legacy migration (`recoveredFrom` + null); the frontend never re-infers the outcome
 * from an ambiguous content shape.
 */
export function restoreFromSession(session: SessionPayload): TabsState {
  const usedOrdinals = new Map<string, Set<number>>();
  for (const tab of session.tabs) {
    if (
      tab.recoveredFrom === null ||
      tab.displacedLabelOrdinal === undefined ||
      !Number.isInteger(tab.displacedLabelOrdinal) ||
      tab.displacedLabelOrdinal < 1
    ) continue;
    const used = usedOrdinals.get(tab.recoveredFrom) ?? new Set<number>();
    used.add(tab.displacedLabelOrdinal);
    usedOrdinals.set(tab.recoveredFrom, used);
  }
  const tabs = session.tabs.map((t) => {
    // Normalized to this record's own absent value up front, so one test covers both spellings the
    // wire can carry: `null` from the backend, and no key at all from a session written before the
    // field existed. Reading either absence as "recovered" would restore a dirty tab as clean and
    // drop its buffer at the next save.
    const recoveredFrom = t.recoveredFrom ?? undefined;
    const recoveryContentOmitted = t.unsavedContentOmitted === true;
    const retainedEmptyContent = recoveryContentOmitted && t.unsavedContent === "";
    let displacedLabelOrdinal: number | undefined;
    if (recoveredFrom !== undefined) {
      const used = usedOrdinals.get(recoveredFrom) ?? new Set<number>();
      displacedLabelOrdinal = t.displacedLabelOrdinal !== undefined &&
        Number.isInteger(t.displacedLabelOrdinal) && t.displacedLabelOrdinal > 0
        ? t.displacedLabelOrdinal
        : undefined;
      if (displacedLabelOrdinal === undefined) {
        displacedLabelOrdinal = 1;
        while (used.has(displacedLabelOrdinal)) displacedLabelOrdinal += 1;
        used.add(displacedLabelOrdinal);
        usedOrdinals.set(recoveredFrom, used);
      }
    }
    return {
      path: t.path,
      dirty: t.unsavedContent !== null && recoveredFrom === undefined,
      ...(recoveredFrom !== undefined && t.docId ? { docId: t.docId } : {}),
      ...(recoveredFrom === undefined ? {} : { recoveredFrom }),
      ...(displacedLabelOrdinal === undefined ? {} : { displacedLabelOrdinal }),
      ...(recoveryContentOmitted ? { recoveryContentOmitted: true } : {}),
      ...(retainedEmptyContent ? { retainedEmptyContent: true } : {}),
      ...(recoveryContentOmitted && t.lossNoticeCollapsed
        ? { lossNoticeCollapsed: true }
        : {}),
    };
  });
  if (tabs.length === 0) return EMPTY_TABS;
  const activePath = tabs.some((t) => t.path === session.activePath)
    ? session.activePath
    : tabs[0].path;
  return { tabs, activePath };
}

/**
 * Builds the `SessionPayload` to persist for `state`: each tab's current content, via
 * `contentOf(path)` (the live source of truth is the mounted CM6 editor, not this store — see
 * `editor/TabbedEditor.tsx`), collapsed to `unsavedContent: null` for clean tabs so a clean tab
 * always restores from disk rather than a redundant snapshot. The per-tab byte cap is enforced
 * backend-side (`store::tab_session::TabSnapshot::new`), not here.
 *
 * An untitled recovery document is persisted whether or not it is dirty (it never is): it has no
 * disk to restore from, so this snapshot is the only durable copy of the displaced work, and
 * collapsing it to `null` would make quitting the app discard it (CJ, 2026-08-11).
 */
// @anchor:tabs-to-session-payload
export function toSessionPayload(
  state: TabsState,
  contentOf: (path: string) => string,
): SessionPayload {
  return {
    tabs: state.tabs.map((t) => {
      const recoveryContentOmitted = t.recoveryContentOmitted === true;
      const content = contentOf(t.path);
      return {
        path: t.path,
        ...(isRecoveredTab(t) && t.docId ? { docId: t.docId } : {}),
        unsavedContent: recoveryContentOmitted && content.length === 0 && !t.retainedEmptyContent
          ? null
          : t.dirty || isRecoveredTab(t)
            ? content
            : null,
        recoveredFrom: t.recoveredFrom ?? null,
        ...(t.displacedLabelOrdinal === undefined
          ? {}
          : { displacedLabelOrdinal: t.displacedLabelOrdinal }),
        ...(recoveryContentOmitted ? { unsavedContentOmitted: true } : {}),
        ...(recoveryContentOmitted && t.lossNoticeCollapsed
          ? { lossNoticeCollapsed: true }
          : {}),
      };
    }),
    activePath: state.activePath,
  };
}
