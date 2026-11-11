// ABOUTME: Comment-anchor highlight decorations (P2b-4a, §3.3's second decoration family alongside
// ABOUTME: the CriticMarkup redline) — anchored threads become live ranges that follow the text
// ABOUTME: through edits, drawn viewport-scoped (TD-13/#216) and coloured by ux-design §2 thread state,
// ABOUTME: with a click deep-link back to the thread (Principle 6). Read-only: this layer reads state
// ABOUTME: and emits decorations, and never issues a doc-mutating transaction (P1).
import {
  type ChangeDesc,
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { type CommentThread, type ThreadState, deriveThreadState } from "../comments/types";
import { createDiskRangeProjector } from "./document";
import { selectionSnapshot, type SelectionSnapshot } from "./selectionWatcher";

/**
 * One anchored thread's *live* position in the open document, plus the ux-design.md §2 state that
 * colours it. Distinct from `comments/types.ts`'s `Anchor` (the persisted shape: offset/length as of
 * `base_revision`, with the quote and context the backend re-checks against): this is what that
 * anchor has become in the buffer the user is looking at right now, after every edit since.
 */
export interface CommentAnchor {
  threadId: string;
  /** Drives the highlight's state colour and underline style — see `commentHighlightTheme` below. */
  state: ThreadState;
  from: number;
  to: number;
}

/**
 * A thread list plus the document revision its offsets are expressed against (`Anchor.base_revision`
 * — TD-6's content hash, the same string `open_document` returns). The revision is what makes the
 * seed checkable: without it a seed is an unverifiable position claim.
 *
 * `threads[].anchor.offset`/`.length` are consumed as **CM6 positions** (`anchorsOf` below reads
 * `anchor.offset` straight into `CommentAnchor.from`, no conversion), while the backend resolves
 * persisted anchors against raw disk text. `commentThreadSeedFromDisk` below is the sole adapter:
 * it proves the disk text still describes the buffer and projects raw ranges into CM6's
 * one-position-per-line-break coordinate space before any dispatcher constructs this payload
 * (#447/#1326/#1799).
 */
export interface CommentThreadSeed {
  threads: readonly CommentThread[];
  /** The `revision` the backend read these threads against — see `documentRevisionField`. */
  revision: string;
}

/**
 * Prepares backend-resolved comment threads for `setCommentThreads`: their persisted anchors index
 * the raw document text the backend read, while the effect consumes CM6 positions. Returns `null`
 * when that source text is neither the current buffer's CM6-position text nor its exact
 * serialization, or any live anchor boundary cannot be represented honestly; callers then keep the
 * existing mapped highlights rather than seed a confidently wrong position (D17/P2).
 * Document-level and orphaned threads need no projected range but remain in the seed so the
 * parallel severity lookup retains the complete thread set.
 */
export function commentThreadSeedFromDisk(
  state: EditorState,
  diskText: string,
  threads: readonly CommentThread[],
  revision: string,
): CommentThreadSeed | null {
  const projectRange = createDiskRangeProjector(state, diskText);
  if (!projectRange) return null;
  const projected: CommentThread[] = [];
  for (const thread of threads) {
    if (!thread.anchor || thread.orphaned) {
      projected.push(thread);
      continue;
    }
    const range = projectRange(thread.anchor.offset, thread.anchor.length);
    if (!range) return null;
    projected.push({ ...thread, anchor: { ...thread.anchor, ...range } });
  }
  return { threads: projected, revision };
}

/**
 * Seeds (and re-seeds) the open document's thread list — dispatched by whoever owns thread loading
 * (`comments/ipc.ts`'s `loadCommentThreads`, and every create/reply/resolve/re-anchor response,
 * which all return the document's full updated list). Always the *whole* list, never a delta: the
 * backend's fold is the single source of thread state (TD-2), so the editor mirrors it wholesale
 * rather than maintaining a second, divergent copy.
 *
 * The seed is *rejected* unless its `revision` is the one the buffer currently holds — see
 * `documentRevisionField`. Thread loading is async, so a seed can arrive describing text the user
 * has already typed over. The revision check alone does **not** prove the offsets are safe to draw:
 * it names the buffer's *bytes* (`serializeDocumentState`), not its position space, so on a CRLF
 * document a same-revision seed can still carry disk-space offsets — see `CommentThreadSeed`'s own
 * doc for the coordinate-space contract this effect's payload must satisfy before it is dispatched.
 */
export const setCommentThreads = StateEffect.define<CommentThreadSeed>();

/**
 * Selects one thread's anchor, or clears the selection with `null`. This is deliberately an
 * editor-state effect rather than module-global/DOM state: the thread card and gutter interactions
 * specified by `docs/design/specs/comments.md` can drive the same per-view seam, while a document
 * switch starts with no selection. Selection composes with every thread state: the anchor keeps its
 * state class and gains the selected one (`comments.md` → *Anchor highlights in the text*).
 */
export const setSelectedCommentThread = StateEffect.define<string | null>();

const selectedCommentThreadField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSelectedCommentThread)) value = effect.value;
    }
    return value;
  },
});

/**
 * Declares that the buffer's text is now exactly the backend revision `revision` — dispatched by
 * the document layer at the two moments that is true: a load (`open_document`'s payload) and a
 * successful save (the revision the write returned). Dispatch it in the *same transaction* as the
 * text it describes.
 */
export const setDocumentRevision = StateEffect.define<string>();

/**
 * Which backend revision the buffer's text currently is, or `null` for "no known revision" — the
 * state after any local edit, since the moment the user types, the buffer stops being the text any
 * revision names. Cheap by construction: a null-out on `docChanged`, never a re-hash on the
 * keystroke path (FR-X-4).
 *
 * Lives here because the comment-highlight seam is its only consumer today (YAGNI); it is a
 * document-level fact and belongs in a document-level home the moment a second consumer appears.
 */
export const documentRevisionField = StateField.define<string | null>({
  create: () => null,
  update: (_value, tr) => bufferRevision(tr),
});

/**
 * The buffer's revision once `tr` has been applied: whatever the transaction declares, else `null`
 * if it edited the text, else what it was. `null` also covers "the revision field isn't installed",
 * in which case no seed is ever verifiable and so none is ever accepted.
 *
 * The prior value is read off `tr.startState` rather than `tr.state` so that the field above and
 * the anchor field below share one rule and cannot drift, without either depending on CM6's
 * field-initialization order — `startState` is always fully computed, a not-yet-computed field on
 * `tr.state` is a trap.
 */
function bufferRevision(tr: Transaction): string | null {
  for (const effect of tr.effects) {
    if (effect.is(setDocumentRevision)) return effect.value;
  }
  if (tr.docChanged) return null;
  return tr.startState.field(documentRevisionField, false) ?? null;
}

/**
 * Converts a seeded thread list to live anchors, dropping every thread that has no honest position
 * to draw (P2: "never a wrong silent position"):
 *   - **document-level** threads (`anchor: null`, FR-CMT-1) — nothing to anchor to, by definition.
 *   - **orphaned** threads (D17) — the backend's `fuzzy_reanchor` already decided the anchored text
 *     is gone; its stale offset now points at unrelated text. The orphan card (P2a-18) with its
 *     preserved quote is the honest surface, and drawing a highlight at that offset would be exactly
 *     the wrong-position failure D17 exists to prevent.
 *   - **empty or out-of-range** anchors — a zero-length anchor has no text to mark, and an anchor
 *     reaching past the end of this buffer belongs to a document state the editor is not showing.
 *     Both are dropped rather than clamped: a clamped highlight is a confidently-drawn guess.
 * Sorted by position because CM6 requires decorations in document order, and thread arrival order
 * (causal, per the fold) has nothing to do with document order.
 */
function anchorsOf(threads: readonly CommentThread[], docLength: number): CommentAnchor[] {
  const anchors: CommentAnchor[] = [];
  for (const thread of threads) {
    const { anchor } = thread;
    if (!anchor || thread.orphaned || thread.withdrawn_at != null) continue;
    const from = anchor.offset;
    const to = anchor.offset + anchor.length;
    if (anchor.length <= 0 || from < 0 || to > docLength) continue;
    anchors.push({ threadId: thread.id, state: deriveThreadState(thread), from, to });
  }
  return anchors.sort((a, b) => a.from - b.from || a.to - b.to);
}

/**
 * Carries an anchor across one transaction's edits. The *anchor semantics* — matching a quote
 * against changed text, deciding relocated-vs-orphaned — are `textops`' job (`anchor::map_through`
 * / `fuzzy_reanchor`, P1-4/P1-5b), re-run backend-side on every load and mutation; this is only the
 * CM6 half: carrying the already-decided range forward through the keystrokes since, via CM6's own
 * `ChangeDesc.mapPos`. No offset arithmetic is reimplemented here.
 *
 * The association arguments make the highlight *not* absorb text typed at either edge: `from` maps
 * with `1` (an insertion exactly at the start pushes the highlight rightwards, staying off it) and
 * `to` with `-1` (an insertion exactly at the end stays outside). A comment anchors the quote the
 * user selected, so text typed against its edges is new, unanchored prose.
 *
 * Returns `null` when the anchored text has been deleted outright (the mapped range collapses):
 * drawing a zero-width mark at the seam would be a position claim about text that no longer exists.
 * The backend's re-check turns that thread into an orphan on the next load; until then this layer
 * simply stops drawing it.
 */
function mapAnchor(anchor: CommentAnchor, changes: ChangeDesc): CommentAnchor | null {
  const from = changes.mapPos(anchor.from, 1);
  const to = changes.mapPos(anchor.to, -1);
  if (to <= from) return null;
  return { ...anchor, from, to };
}

/**
 * The open document's live comment anchors, in document order. A `StateField` (not a `ViewPlugin`)
 * because an anchor's position is a property of the *document*, not of what happens to be on screen
 * — it must stay correct for offscreen threads so scrolling one into view draws it in the right
 * place. The viewport scoping lives one layer up, in the plugin that turns these into decorations.
 */
export const commentAnchorsField = StateField.define<CommentAnchor[]>({
  create: () => [],
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setCommentThreads)) continue;
      // A seed is authoritative *only* for the revision it was read against. When that is the
      // revision `tr` leaves the buffer at, its offsets describe `tr.newDoc` exactly — PROVIDED the
      // caller already established the seed's offsets are in CM6 position space (the revision match
      // alone proves same *bytes* — `serializeDocumentState` — never same position space; see
      // `CommentThreadSeed`'s doc). Describing `tr.newDoc` exactly is what lets such a seed replace
      // the set outright rather than being mapped through this transaction's own changes on top.
      // Otherwise it describes text the buffer no longer holds — thread loading is async, so a seed
      // can arrive after the user has typed over the text it was read from — and every offset in it
      // is a confidently-wrong position (P2). Such a seed is dropped whole, keeping the anchors
      // already in the field, which CM6 has mapped honestly through those same edits.
      // Their thread *state* may lag until the next in-revision seed: a stale colour, never a
      // stale position.
      if (effect.value.revision === bufferRevision(tr)) {
        return anchorsOf(effect.value.threads, tr.newDoc.length);
      }
    }
    // The overwhelmingly common case is a document with no comments at all: keep that path
    // allocation-free, since it runs on every keystroke.
    if (!tr.docChanged || value.length === 0) return value;
    const mapped: CommentAnchor[] = [];
    for (const anchor of value) {
      const next = mapAnchor(anchor, tr.changes);
      if (next) mapped.push(next);
    }
    return mapped;
  },
});

/** Every live comment anchor in `state`, in document order — empty when the field isn't installed. */
export function commentAnchors(state: EditorState): CommentAnchor[] {
  return state.field(commentAnchorsField, false) ?? [];
}

/**
 * `threadId -> severity` for the buffer's current seed (P2b-4b, D6) — the join key the severity
 * margin-mark layer (`severityMarginMarks.ts`) reads to decide *which* of `commentAnchors`' already-
 * positioned anchors get a mark, without that layer re-deriving anchor positions itself. Keeping this
 * as a plain id→severity lookup rather than folding `severity` into `CommentAnchor` keeps this
 * module's own anchor shape (and every existing test asserting it) untouched — `CommentAnchor` is the
 * *position* fact both the highlight and the margin mark draw from (their shared "same anchor" the
 * P2b-4b card's acceptance criteria requires); severity is a separate, position-independent fact
 * about the thread the margin mark alone needs.
 *
 * Gated by the identical in-revision check `commentAnchorsField` uses, for the identical reason: a
 * seed read against text the buffer no longer holds may name threads that no longer anchor where this
 * map would imply. Unlike anchors, a dropped stale seed here has nothing to "keep mapped" (severity
 * isn't a position CM6 can carry through edits), so the field simply holds its last in-revision value
 * until the next one arrives — a stale severity for a thread whose highlight has already moved is the
 * same acceptable lag `commentAnchorsField`'s own docs describe for thread *state*.
 */
export const severityByThreadField = StateField.define<ReadonlyMap<string, string | null>>({
  create: () => new Map(),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setCommentThreads)) continue;
      if (effect.value.revision === bufferRevision(tr)) {
        return new Map(effect.value.threads.map((thread) => [thread.id, thread.severity]));
      }
    }
    return value;
  },
});

/** The severity (`CommentThread.severity`, `null` for an ordinary human comment or an unknown thread
 * id) `threadId` carries in `state`'s current seed — `undefined` when the field isn't installed. */
export function severityOf(state: EditorState, threadId: string): string | null | undefined {
  return state.field(severityByThreadField, false)?.get(threadId);
}

/** The DOM attribute a highlight carries its thread id in — read back by the click handler below to
 * deep-link, and by tests. */
const THREAD_ATTRIBUTE = "data-comment-thread";

/**
 * The `Decoration.mark` for one anchor, classed by its ux-design.md §2 *thread state* (open /
 * working / addressed-pending / reopened / resolved), plus `cm-commentHighlight-selected` when it is
 * the selected thread whatever its state, and tagged with its thread id for the click deep-link.
 *
 * Deliberately **not** J3 Phase A's severity encoding: that channel maps colour to a finding's
 * C/H/M/L severity and owes §2's "always colour + letter chip" accessibility rule a non-colour
 * signal. This layer draws comment threads (FR-CMT-*), which have states, not severities — so no
 * letter chip is owed here. When Phase C brings finding severity into the text it needs a channel
 * of its own that does not collide with this one; that is a design question for the card that
 * builds it, deliberately left open rather than pre-answered here.
 *
 * Built fresh per rebuild rather than hoisted to module constants the way the structural family's
 * marks are: those are static, these carry a per-thread attribute, so there is nothing constant to
 * share. `orphaned` never reaches here (`anchorsOf` drops it — the P2a-18 orphan card is that
 * thread's honest surface, so there is deliberately no CSS for it); `suggestion` is in
 * `ThreadState`'s range but not derivable until P2b-3 supplies the proposed-replacement payload
 * (D19), and is styled ahead of that so the state it names renders when it arrives.
 */
function highlightFor(anchor: CommentAnchor, selectedThreadId: string | null) {
  const selected = anchor.threadId === selectedThreadId;
  return Decoration.mark({
    class: `cm-commentHighlight cm-commentHighlight-${anchor.state}${selected ? " cm-commentHighlight-selected" : ""}`,
    attributes: { [THREAD_ATTRIBUTE]: anchor.threadId },
  });
}

/**
 * Builds decorations for the anchors overlapping `ranges` — the on-screen spans only. Following
 * #216's precedent for the structural family: a document with hundreds of threads must not pay for
 * all of them on the keystroke path (FR-X-4). The anchors themselves are already mapped by the
 * field above, so this is a filter plus a `Decoration.mark` per *visible* thread, not a re-scan.
 */
function buildHighlights(state: EditorState, ranges: readonly { from: number; to: number }[]): DecorationSet {
  const anchors = commentAnchors(state);
  if (anchors.length === 0) return Decoration.none;
  const selectedThreadId = state.field(selectedCommentThreadField);
  const visible = anchors.filter((anchor) =>
    ranges.some((range) => anchor.from < range.to && anchor.to > range.from),
  );
  return Decoration.set(
    visible.map((anchor) => highlightFor(anchor, selectedThreadId).range(anchor.from, anchor.to)),
    true,
  );
}

/** Whether `update` could have changed the visible highlight set: an edit (anchors remapped), a
 * viewport move (a different slice of them is on screen), or a re-seed. Anything else — a plain
 * cursor nudge — reuses the previous set, exactly as `structuralInputsChanged` does. */
function highlightInputsChanged(update: ViewUpdate): boolean {
  if (update.docChanged || update.viewportChanged) return true;
  return update.transactions.some((tr) =>
    tr.effects.some((effect) => effect.is(setCommentThreads) || effect.is(setSelectedCommentThread)),
  );
}

/**
 * The live highlight layer. A `ViewPlugin` for the same reason `structuralDecorationsPlugin` is one
 * (TD-13/SPIKE-3/#216): only a plugin can read `view.visibleRanges`, so build cost is bounded by
 * what is rendered rather than by how many threads the document carries.
 */
class CommentHighlightsPluginValue {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildHighlights(view.state, view.visibleRanges);
  }

  update(update: ViewUpdate) {
    if (!highlightInputsChanged(update)) return;
    this.decorations = buildHighlights(update.state, update.view.visibleRanges);
  }
}

export const commentHighlightsPlugin = ViewPlugin.fromClass(CommentHighlightsPluginValue, {
  decorations: (plugin) => plugin.decorations,
});

function paragraphStart(state: EditorState, pos: number): number {
  let node = syntaxTree(state).resolveInner(pos, -1);
  while (node.parent) {
    if (node.name === "Paragraph" || node.name.startsWith("ATXHeading") || node.name.startsWith("SetextHeading")) {
      return state.doc.lineAt(node.from).from;
    }
    node = node.parent;
  }
  return state.doc.lineAt(pos).from;
}

class CommentGutterWidget extends WidgetType {
  constructor(
    readonly anchor: CommentAnchor,
    readonly selected: boolean,
    readonly top: number,
    readonly ordinal: number,
    readonly total: number,
    readonly onSelectThread: (threadId: string) => void,
  ) { super(); }

  eq(other: CommentGutterWidget): boolean {
    return this.anchor.threadId === other.anchor.threadId && this.anchor.state === other.anchor.state
      && this.selected === other.selected && this.top === other.top
      && this.ordinal === other.ordinal && this.total === other.total;
  }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `cm-commentGutterIcon cm-commentGutterIcon-${this.selected ? "selected" : this.anchor.state}`;
    button.setAttribute("data-comment-gutter-thread", this.anchor.threadId);
    button.setAttribute("aria-label", `Show comment thread ${this.ordinal} of ${this.total}`);
    button.style.top = `${this.top}px`;
    button.textContent = this.selected ? "+" : this.anchor.state === "resolved" ? "✓" : "";
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", () => {
      view.dispatch({ effects: setSelectedCommentThread.of(this.anchor.threadId) });
      this.onSelectThread(this.anchor.threadId);
    });
    return button;
  }

  ignoreEvent(): boolean { return true; }
}

class CommentGutterAddWidget extends WidgetType {
  constructor(
    readonly top: number,
    readonly onAddSelection: (selection: SelectionSnapshot) => void,
  ) { super(); }

  eq(other: CommentGutterAddWidget): boolean { return this.top === other.top; }

  toDOM(view: EditorView): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cm-commentGutterIcon cm-commentGutterIcon-selected cm-commentGutterIcon-add";
    button.setAttribute("data-comment-gutter-add", "");
    button.setAttribute("aria-label", "Add comment to selected text");
    button.style.top = `${this.top}px`;
    button.textContent = "+";
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("click", () => {
      const selection = selectionSnapshot(view.state);
      if (selection) this.onAddSelection(selection);
    });
    return button;
  }

  ignoreEvent(): boolean { return true; }
}

function commentGutterPlugin(
  onSelectThread: (threadId: string) => void,
  onAddSelection?: (selection: SelectionSnapshot) => void,
  canAddSelection?: () => boolean,
) {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(update: ViewUpdate) {
      if (!highlightInputsChanged(update) && !update.geometryChanged
        && !(onAddSelection && update.selectionSet)
        && syntaxTree(update.startState) === syntaxTree(update.state)) return;
      this.decorations = this.build(update.view);
    }

    private build(view: EditorView): DecorationSet {
      const selected = view.state.field(selectedCommentThreadField);
      let lastIconBottom = Number.NEGATIVE_INFINITY;
      const allAnchors = commentAnchors(view.state);
      const selection = onAddSelection && (canAddSelection?.() ?? true)
        ? selectionSnapshot(view.state) : null;
      const inView = (from: number, to: number) =>
        view.visibleRanges.some((range) => from < range.to && to > range.from);
      const candidates: Array<{ from: number; anchor: CommentAnchor; index: number } | { from: number; add: true }> =
        allAnchors.map((anchor, index) => ({ anchor, index }))
          .filter(({ anchor }) => inView(anchor.from, anchor.to))
          .map(({ anchor, index }) => ({ from: paragraphStart(view.state, anchor.from), anchor, index }));
      if (selection && inView(selection.offset, selection.offset + selection.length)) {
        candidates.push({ from: paragraphStart(view.state, selection.offset), add: true });
      }
      candidates.sort((a, b) => a.from - b.from
        || Number("add" in a) - Number("add" in b)
        || (!("add" in a) && !("add" in b) ? a.index - b.index : 0));
      const icons = candidates.map((candidate) => {
        const { from } = candidate;
        const lineTop = view.lineBlockAt(from).top;
        // Keep the icon attached to its paragraph, then nudge any later icon below the preceding
        // target, even when the next paragraph starts before a same-paragraph stack has ended.
        const top = Math.max(2, lastIconBottom + 4 - lineTop);
        const isAdd = "add" in candidate;
        const isSelected = !isAdd && selected === candidate.anchor.threadId;
        lastIconBottom = lineTop + top + (isAdd || isSelected ? 22 : 20);
        return Decoration.widget({
          widget: isAdd
            ? new CommentGutterAddWidget(top, onAddSelection!)
            : new CommentGutterWidget(candidate.anchor, isSelected, top, candidate.index + 1, allAnchors.length, onSelectThread),
          side: -1,
        }).range(from);
      });
      return icons.length ? Decoration.set(icons, true) : Decoration.none;
    }
  }, { decorations: (plugin) => plugin.decorations });
}

/**
 * The deep-link (UX Principle 6 — everything in the text links back to the panel): a mousedown on a
 * highlight reports its thread id so the timeline can scroll to that thread.
 *
 * Deliberately does **not** consume the event (no `preventDefault`, returns `false`): CM6's own
 * mousedown handling then runs untouched, so the click places the caret and the editor keeps focus.
 * The panel scrolls to the thread; the user's typing position is never taken away from them (UX
 * Principle 2). The thread id is read off the DOM rather than from `posAtCoords` so the exact
 * element the user pressed decides the target — unambiguous when two anchors abut.
 *
 * **Mouse-only, deliberately, and #259 owns the keyboard equivalent.** A keyboard user whose caret
 * sits inside an anchored span currently has no way to reach that thread's card. The binding is not
 * written here because it has nowhere to go yet: the interaction is inert until #259 installs this
 * layer, the focus target it would move to is the panel-side card #259 builds, and tech-design §3.1
 * (FR-X-1) gives the Cmd/Ctrl layer "a single keymap module" — so the binding belongs there rather
 * than inline in a decoration layer. Recorded here
 * (and on the FR-CMT-1 matrix row) so the wiring card inherits the gap instead of rediscovering it.
 */
// @anchor:comment-highlight-deep-link
function deepLinkHandler(onSelectThread: (threadId: string) => void) {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      const target = event.target as HTMLElement | null;
      const highlight = target?.closest?.(`[${THREAD_ATTRIBUTE}]`);
      const threadId = highlight?.getAttribute(THREAD_ATTRIBUTE);
      if (threadId) {
        view.dispatch({ effects: setSelectedCommentThread.of(threadId) });
        onSelectThread(threadId);
      }
      return false;
    },
  });
}

/** A state's patterned line as `border-bottom` longhands. A border survives Windows High Contrast,
 * which drops box shadows (comments.md *Forced colours*); longhands let a selected rule recolour the
 * line without restating its pattern. */
function bottomLine(width: string, style: string, color: string) {
  return { borderBottomWidth: width, borderBottomStyle: style, borderBottomColor: color };
}

/**
 * State colours for the highlight (ux-design.md §2's thread states — see `highlightFor` on why this
 * is not J3's severity channel). Kept to a soft background wash plus a thin line rather than a
 * strong fill: the highlight sits *under* live, editable prose that must stay comfortably readable
 * (Principle 1 — the document is the centre of gravity, not the annotation).
 *
 * The rule is `docs/design/specs/comments.md` → *Anchor highlights in the text*: **the fill says
 * whether the thread is selected; the line says its state**, by pattern and weight as well as
 * colour. Open draws a 1px solid shadow line; Working 1px dotted; Addressed — pending 2px dashed;
 * Reopened 3px double; Suggestion 1px solid plus a wavy underline; Resolved 1px dashed on no fill.
 * Selection swaps in the selected fill and keeps the state's pattern and weight: Working and
 * Addressed — pending redraw theirs in the accent, Open's shadow line takes the selected border,
 * Resolved's line strengthens to hold 3:1, and Reopened and Suggestion keep their own line colour. That is how ux-design.md §2's fourth carrier holds —
 * Working and Addressed — pending never differ by colour alone, selected or not. Patterned lines
 * are borders rather than shadows so they survive forced colours.
 *
 * Every colour below is a `--color-comment-highlight-*` token (`styles.css`), never a literal, for
 * the identical reason `structuralTheme`'s frontmatter fold and `severityMarginTheme` already read
 * palette tokens rather than hex: CSS custom properties cross the stylesheet boundary freely, so a
 * `baseTheme` colocated with its own decoration module can share the app's palette without
 * duplicating its values, and each token carries a light and a dark value. Both themes' values
 * come from `docs/design/specs/tokens.md` → *Comment-anchor states* (refreshes (32)–(34)), which
 * specifies dark for this surface; `docs/design/specs/state.md` records that carve-out from the
 * folder's otherwise-unspecified dark mode. jsdom resolves no custom property, so the drawn colour
 * is a CJ hands-on check; what the tests pin is each rule's token, pattern and weight, and each
 * token's declared value in both themes.
 */
const commentHighlightTheme = EditorView.baseTheme({
  ".cm-commentHighlight": {
    cursor: "pointer",
  },
  ".cm-commentHighlight-open": {
    backgroundColor: "var(--color-comment-highlight-open-bg)",
    boxShadow: "0 1px 0 var(--color-comment-highlight-open-border)",
  },
  ".cm-commentHighlight-working": {
    backgroundColor: "var(--color-comment-highlight-working-bg)",
    ...bottomLine("1px", "dotted", "var(--color-comment-highlight-working-border)"),
  },
  ".cm-commentHighlight-addressed-pending": {
    backgroundColor: "var(--color-comment-highlight-addressed-pending-bg)",
    ...bottomLine("2px", "dashed", "var(--color-comment-highlight-addressed-pending-border)"),
  },
  ".cm-commentHighlight-reopened": {
    backgroundColor: "var(--color-comment-highlight-reopened-bg)",
    ...bottomLine("3px", "double", "var(--color-comment-highlight-reopened-border)"),
  },
  ".cm-commentHighlight-suggestion": {
    backgroundColor: "var(--color-comment-highlight-suggestion-bg)",
    ...bottomLine("1px", "solid", "var(--color-comment-highlight-suggestion-border)"),
    textDecorationLine: "underline",
    textDecorationStyle: "wavy",
    textDecorationColor: "var(--color-comment-highlight-suggestion-border)",
    textUnderlineOffset: "2px",
  },
  ".cm-commentHighlight-resolved": {
    backgroundColor: "transparent",
    ...bottomLine("1px", "dashed", "var(--color-comment-highlight-resolved-border)"),
  },
  // Selection: the compound selectors outrank each single state class, so the selected fill wins
  // over every state's fill while the state's line pattern and weight stay as drawn above.
  ".cm-commentHighlight.cm-commentHighlight-selected": {
    backgroundColor: "var(--color-comment-highlight-selected-bg)",
  },
  ".cm-commentHighlight-open.cm-commentHighlight-selected": {
    boxShadow: "0 1px 0 var(--color-comment-highlight-selected-border)",
  },
  ".cm-commentHighlight-working.cm-commentHighlight-selected": {
    borderBottomColor: "var(--color-comment-highlight-selected-pattern-border)",
  },
  ".cm-commentHighlight-addressed-pending.cm-commentHighlight-selected": {
    borderBottomColor: "var(--color-comment-highlight-selected-pattern-border)",
  },
  ".cm-commentHighlight-resolved.cm-commentHighlight-selected": {
    borderBottomColor: "var(--color-comment-highlight-selected-resolved-border)",
  },
});

/**
 * The comment-highlight extension bundle `editor/` wires into a document's state: the live anchor
 * field, the severity join table `severityMarginMarks.ts` reads alongside it (P2b-4b), the
 * viewport-scoped decoration plugin, the CSS, and — when a deep-link target is given — the click
 * handler. Pass `onSelectThread` to have clicks reported and `onAddSelection` to expose the
 * selection-time draft control. Omit the callbacks and the layer is purely visual.
 */
export function commentHighlightExtensions(
  onSelectThread?: (threadId: string) => void,
  onAddSelection?: (selection: SelectionSnapshot) => void,
  canAddSelection?: () => boolean,
): Extension[] {
  return [
    documentRevisionField,
    commentAnchorsField,
    severityByThreadField,
    selectedCommentThreadField,
    commentHighlightsPlugin,
    ...(onSelectThread ? [commentGutterPlugin(onSelectThread, onAddSelection, canAddSelection)] : []),
    commentHighlightTheme,
    ...(onSelectThread ? [deepLinkHandler(onSelectThread)] : []),
  ];
}
