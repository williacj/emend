// ABOUTME: J14 inline and block format commands that edit live Markdown in one isolated history event.
// ABOUTME: They preserve authored targets and CriticMarkup identity/geometry through undo/redo.
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { historyField, isolateHistory } from "@codemirror/commands";
import {
  EditorSelection,
  EditorState,
  ChangeSet,
  type ChangeSpec,
  type Extension,
  type SelectionRange,
  type TransactionSpec,
} from "@codemirror/state";
import type { SyntaxNode, Tree } from "@lezer/common";
import type { EditorView } from "@codemirror/view";
import { frontmatterEndFromState } from "./structuralDecorations";
import {
  delimiterSpans,
  formattingGeometryEffect,
  trackedChanges,
  type ChangeSpan,
} from "./trackedChanges";

export type FormatCommandResult =
  | { status: "applied" }
  | { status: "pending" }
  | { status: "unchanged" }
  | { status: "unavailable"; reason: FormatUnavailableReason };

export type FormatExcludedRegion = "YAML frontmatter" | "code" | "a table" | "HTML";
export type FormatUnavailableReason =
  `${"Bold" | "Italic" | "Heading 1" | "Bulleted list"} isn't available for this selection because it includes ${FormatExcludedRegion}.`;

export type FormatControlStatus = "active" | "inactive" | "pending";

export interface FormatControlStates {
  bold: FormatControlStatus;
  italic: FormatControlStatus;
  heading1: FormatControlStatus;
  bulletedList: FormatControlStatus;
}

type InlineFormat = "bold" | "italic";
type BlockFormat = "heading1" | "bulletedList";
type FormatKind = InlineFormat | BlockFormat;

interface InlineFormatDefinition {
  control: "Bold" | "Italic";
  marker: "**" | "*";
  nodeName: "StrongEmphasis" | "Emphasis";
  userEvent: "input.format.bold" | "input.format.italic";
}

interface FormatRun {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  open: ChangeSpan;
  close: ChangeSpan;
}

interface InlineTarget {
  from: number;
  to: number;
}

const FORMATS: Record<InlineFormat, InlineFormatDefinition> = {
  bold: {
    control: "Bold",
    marker: "**",
    nodeName: "StrongEmphasis",
    userEvent: "input.format.bold",
  },
  italic: {
    control: "Italic",
    marker: "*",
    nodeName: "Emphasis",
    userEvent: "input.format.italic",
  },
};

function rangeTouches(from: number, to: number, span: ChangeSpan): boolean {
  return from === to
    ? from >= span.from && from < span.to
    : from < span.to && to > span.from;
}

function parsedTreeForActiveRead(state: EditorState, to: number): Tree | null {
  const upto = Math.min(state.doc.length, Math.max(to, 1));
  return syntaxTreeAvailable(state, upto) ? syntaxTree(state) : null;
}

function formatRun(node: SyntaxNode): FormatRun | null {
  const marks: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "EmphasisMark") marks.push(child);
  }
  const open = marks[0];
  const close = marks[marks.length - 1];
  if (!open || !close || open === close) return null;
  return {
    from: node.from,
    to: node.to,
    contentFrom: open.to,
    contentTo: close.from,
    open: { from: open.from, to: open.to },
    close: { from: close.from, to: close.to },
  };
}

function collectRuns(
  tree: Tree,
  nodeName: InlineFormatDefinition["nodeName"],
  targets: readonly InlineTarget[],
  docLength: number,
): FormatRun[] {
  const runs: FormatRun[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const from = target.from === target.to ? Math.max(0, target.from - 1) : target.from;
    const to = target.from === target.to ? Math.min(docLength, target.to + 1) : target.to;
    tree.iterate({
      from,
      to,
      enter(ref) {
        if (ref.name !== nodeName) return;
        const run = formatRun(ref.node);
        const key = run && `${run.from}:${run.to}`;
        if (run && key && !seen.has(key)) {
          seen.add(key);
          runs.push(run);
        }
      },
    });
  }
  return runs;
}

function trimTarget(state: EditorState, span: ChangeSpan): InlineTarget | null {
  let { from, to } = span;
  while (from < to && /\s/.test(state.doc.sliceString(from, from + 1))) from += 1;
  while (to > from && /\s/.test(state.doc.sliceString(to - 1, to))) to -= 1;
  return from < to ? { from, to } : null;
}

function inlineContainerContent(state: EditorState, node: SyntaxNode): ChangeSpan {
  if (node.name === "Paragraph" || node.name === "TableCell") {
    return { from: node.from, to: node.to };
  }
  if (node.name === "Task") {
    const marker = node.getChild("TaskMarker");
    return { from: marker?.to ?? node.from, to: node.to };
  }
  if (node.name.startsWith("SetextHeading")) {
    return { from: node.from, to: state.doc.lineAt(node.from).to };
  }

  const marks: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "HeaderMark") marks.push(child);
  }
  const opening = marks[0];
  const closing = marks.length > 1 ? marks[marks.length - 1] : null;
  let from = opening?.to ?? node.from;
  let to = closing?.from ?? node.to;
  while (from < to && /[ \t]/.test(state.doc.sliceString(from, from + 1))) from += 1;
  while (to > from && /[ \t]/.test(state.doc.sliceString(to - 1, to))) to -= 1;
  return { from, to };
}

/** Split a cross-block selection at semantic prose blocks. Markdown emphasis cannot cross a blank
 * line, so each block gets its own pair while the command remains one transaction and selection. */
function inlineTargets(
  state: EditorState,
  tree: Tree,
  from: number,
  to: number,
): InlineTarget[] {
  if (from === to) return [{ from, to }];
  const targets: InlineTarget[] = [];
  tree.iterate({
    from,
    to,
    enter(ref) {
      const isInlineContainer =
        ref.name === "Paragraph" ||
        ref.name === "TableCell" ||
        ref.name === "Task" ||
        ref.name.startsWith("ATXHeading") ||
        ref.name.startsWith("SetextHeading");
      if (!isInlineContainer) return;
      const content = inlineContainerContent(state, ref.node);
      const target = trimTarget(state, {
        from: Math.max(from, content.from),
        to: Math.min(to, content.to),
      });
      if (target) targets.push(target);
      return false;
    },
  });
  return targets;
}

interface FormatExclusion {
  from: number;
  region: FormatExcludedRegion;
}

function codeExclusion(
  tree: Tree,
  from: number,
  to: number,
  format: FormatKind,
): FormatExclusion | null {
  let first: FormatExclusion | null = null;
  tree.iterate({
    from,
    to,
    enter(node) {
      const isCode =
        node.name === "FencedCode" ||
        node.name === "CodeBlock" ||
        ((format === "bold" || format === "italic") && node.name === "InlineCode");
      if (isCode && rangeTouches(from, to, node)) {
        if (!first || node.from < first.from) first = { from: node.from, region: "code" };
        return false;
      }
    },
  });
  return first;
}

function blockExclusion(
  tree: Tree,
  from: number,
  to: number,
): FormatExclusion | null {
  let first: FormatExclusion | null = null;
  tree.iterate({
    from,
    to,
    enter(node) {
      const region = node.name === "Table"
        ? "a table"
        : node.name === "HTMLBlock"
          ? "HTML"
          : null;
      if (region && rangeTouches(from, to, node)) {
        if (!first || node.from < first.from) first = { from: node.from, region };
        return false;
      }
    },
  });
  return first;
}

function excludedByCriticMarkup(state: EditorState, from: number, to: number): boolean {
  return trackedChanges(state).some((change) =>
    delimiterSpans(change).some((span) =>
      from === to
        ? from > span.from && from < span.to
        : from < span.to && to > span.from,
    ),
  );
}

function pendingPair(state: EditorState, pos: number, format: InlineFormat): ChangeSpan[] | null {
  const marker = FORMATS[format].marker;
  const width = marker.length;
  if (
    pos < width ||
    pos + width > state.doc.length ||
    state.doc.sliceString(pos - width, pos) !== marker ||
    state.doc.sliceString(pos, pos + width) !== marker
  ) {
    return null;
  }
  if (
    format === "italic" &&
    pos >= 2 &&
    pos + 2 <= state.doc.length &&
    state.doc.sliceString(pos - 2, pos + 2) === "****"
  ) {
    return null;
  }
  return [
    { from: pos - width, to: pos },
    { from: pos, to: pos + width },
  ];
}

function containingRun(runs: readonly FormatRun[], from: number, to: number): FormatRun | null {
  return (
    runs
      .filter((run) => run.contentFrom <= from && run.contentTo >= to)
      .sort((a, b) => a.to - a.from - (b.to - b.from))[0] ?? null
  );
}

function authoredTarget(run: FormatRun, target: InlineTarget): InlineTarget {
  return {
    from: Math.max(target.from, run.contentFrom),
    to: Math.min(target.to, run.contentTo),
  };
}

function removalChanges(
  state: EditorState,
  run: FormatRun,
  from: number,
  to: number,
): ChangeSpec[] {
  if (from === to) {
    return [
      { from: run.open.from, to: run.open.to },
      { from: run.close.from, to: run.close.to },
    ];
  }
  const marker = state.doc.sliceString(run.open.from, run.open.to);
  const changes: ChangeSpec[] = [];
  if (from === run.contentFrom) changes.push({ from: run.open.from, to: run.open.to });
  else {
    let closeAt = from;
    while (closeAt > run.contentFrom && /\s/.test(state.doc.sliceString(closeAt - 1, closeAt))) {
      closeAt -= 1;
    }
    changes.push({ from: closeAt, insert: marker });
  }
  if (to === run.contentTo) changes.push({ from: run.close.from, to: run.close.to });
  else {
    let openAt = to;
    while (openAt < run.contentTo && /\s/.test(state.doc.sliceString(openAt, openAt + 1))) {
      openAt += 1;
    }
    changes.push({ from: openAt, insert: marker });
  }
  return changes;
}

function applicationChanges(
  runs: readonly FormatRun[],
  from: number,
  to: number,
  marker: string,
): ChangeSpec[] {
  const touching = runs.filter((run) => run.to >= from && run.from <= to);
  let wrapFrom = from;
  let wrapTo = to;
  const changes: ChangeSpec[] = [];
  for (const run of touching) {
    wrapFrom = Math.min(wrapFrom, run.contentFrom);
    wrapTo = Math.max(wrapTo, run.contentTo);
    changes.push(
      { from: run.open.from, to: run.open.to },
      { from: run.close.from, to: run.close.to },
    );
  }
  changes.push({ from: wrapFrom, insert: marker }, { from: wrapTo, insert: marker });
  return changes;
}

function editsCriticDelimiter(state: EditorState, changes: ChangeSet): boolean {
  const delimiters = trackedChanges(state).flatMap(delimiterSpans);
  let touches = false;
  changes.iterChanges((from, to) => {
    if (
      delimiters.some((span) =>
        from === to
          ? from > span.from && from < span.to
          : from < span.to && to > span.from,
      )
    ) {
      touches = true;
    }
  }, true);
  return touches;
}

function rangeExclusion(
  state: EditorState,
  tree: Tree,
  range: SelectionRange,
  format: FormatKind,
): FormatExclusion | null {
  const frontmatterEnd = frontmatterEndFromState(state);
  const { from, to } = range;
  const yaml = from === to ? from < frontmatterEnd : from < frontmatterEnd && to > 0;
  if (yaml) return { from: 0, region: "YAML frontmatter" };
  const code = codeExclusion(tree, from, to, format);
  const block = format === "heading1" || format === "bulletedList"
    ? blockExclusion(tree, from, to)
    : null;
  if (!code) return block;
  if (!block) return code;
  return code.from <= block.from ? code : block;
}

function firstExclusion(
  state: EditorState,
  tree: Tree,
  format: FormatKind,
): FormatExclusion | null {
  return state.selection.ranges
    .map((range) => rangeExclusion(state, tree, range, format))
    .filter((exclusion): exclusion is FormatExclusion => exclusion !== null)
    .sort((a, b) => a.from - b.from)[0] ?? null;
}

function rangeUnavailable(
  state: EditorState,
  tree: Tree,
  range: SelectionRange,
  format: FormatKind,
): boolean {
  return rangeExclusion(state, tree, range, format) !== null ||
    excludedByCriticMarkup(state, range.from, range.to);
}

function selectionTargets(state: EditorState, tree: Tree): InlineTarget[] {
  const targets = state.selection.ranges.flatMap((range) =>
    inlineTargets(state, tree, range.from, range.to),
  );
  return targets.filter(
    (target, index) =>
      index === 0 ||
      target.from !== targets[index - 1].from ||
      target.to !== targets[index - 1].to,
  );
}

function logicalSelection(
  state: EditorState,
  changes: ChangeSet,
  targets: readonly InlineTarget[],
): EditorSelection {
  const backward = state.selection.main.anchor > state.selection.main.head;
  const ranges = targets.map((target) => {
    const mappedFrom = changes.mapPos(target.from, 1);
    const mappedTo = changes.mapPos(target.to, -1);
    return backward
      ? EditorSelection.range(mappedTo, mappedFrom)
      : EditorSelection.range(mappedFrom, mappedTo);
  });
  return EditorSelection.create(ranges, backward ? 0 : ranges.length - 1);
}

type PreparedFormatCommand =
  | { status: "ready"; transaction: TransactionSpec }
  | { status: "unchanged" };

function prepareCommand(
  state: EditorState,
  format: InlineFormat,
  tree: Tree,
): PreparedFormatCommand {
  if (
    state.readOnly ||
    state.selection.ranges.some((range) =>
      excludedByCriticMarkup(state, range.from, range.to),
    )
  ) {
    return { status: "unchanged" };
  }

  const definition = FORMATS[format];
  const targets = selectionTargets(state, tree);
  if (targets.length === 0) return { status: "unchanged" };
  const runs = collectRuns(tree, definition.nodeName, targets, state.doc.length);
  const onlyTarget = targets.length === 1 ? targets[0] : null;
  const pending = onlyTarget && onlyTarget.from === onlyTarget.to
    ? pendingPair(state, onlyTarget.from, format)
    : null;
  const activeRuns = targets.map((target) => containingRun(runs, target.from, target.to));
  const allActive = !pending && activeRuns.every((run) => run !== null);
  const specs = pending
    ? pending.map((span) => ({ from: span.from, to: span.to }))
    : onlyTarget && onlyTarget.from === onlyTarget.to && !allActive
      ? [
          { from: onlyTarget.from, insert: definition.marker },
          { from: onlyTarget.from, insert: definition.marker },
        ]
      : allActive
        ? targets.flatMap((target, index) => {
            const active = activeRuns[index]!;
            const authored = authoredTarget(active, target);
            return removalChanges(state, active, authored.from, authored.to);
          })
        : targets.flatMap((target, index) =>
            activeRuns[index]
              ? []
              : applicationChanges(runs, target.from, target.to, definition.marker),
          );
  if (specs.length === 0) return { status: "unchanged" };
  const changes = state.changes(specs);
  if (changes.empty || editsCriticDelimiter(state, changes)) return { status: "unchanged" };

  const geometry = formattingGeometryEffect(state, changes);
  const selection = pending
    ? EditorSelection.cursor(changes.mapPos(onlyTarget!.from, -1))
    : onlyTarget && onlyTarget.from === onlyTarget.to && !allActive
      ? EditorSelection.cursor(
          changes.mapPos(onlyTarget.from, -1) + definition.marker.length,
        )
      : logicalSelection(state, changes, targets);
  return {
    status: "ready",
    transaction: {
      changes,
      selection,
      effects: geometry ? [geometry] : [],
      annotations: isolateHistory.of("full"),
      userEvent: definition.userEvent,
    },
  };
}

function unavailableResult(
  format: FormatKind,
  region: FormatExcludedRegion,
): FormatCommandResult {
  const control = format === "heading1"
    ? "Heading 1"
    : format === "bulletedList"
      ? "Bulleted list"
      : FORMATS[format].control;
  return {
    status: "unavailable",
    reason: `${control} isn't available for this selection because it includes ${region}.`,
  };
}

function runInlineFormat(view: EditorView, format: InlineFormat): FormatCommandResult {
  if (view.state.readOnly) return { status: "unchanged" };
  const maxTo = Math.max(...view.state.selection.ranges.map((range) => range.to));
  const tree = parsedTreeForActiveRead(view.state, maxTo);
  if (!tree) return { status: "pending" };
  const exclusion = firstExclusion(view.state, tree, format);
  if (exclusion) return unavailableResult(format, exclusion.region);
  const prepared = prepareCommand(view.state, format, tree);
  if (prepared.status === "unchanged") return prepared;
  view.dispatch(prepared.transaction);
  return { status: "applied" };
}

function inlineFormatStatus(
  state: EditorState,
  format: InlineFormat,
  tree: Tree,
): FormatControlStatus {
  if (state.selection.ranges.some((range) => rangeUnavailable(state, tree, range, format))) {
    return "inactive";
  }
  const targets = selectionTargets(state, tree);
  if (targets.length === 0) return "inactive";
  if (
    targets.length === 1 &&
    targets[0].from === targets[0].to &&
    pendingPair(state, targets[0].from, format)
  ) {
    return "active";
  }
  const runs = collectRuns(tree, FORMATS[format].nodeName, targets, state.doc.length);
  return targets.every(
    (target) => containingRun(runs, target.from, target.to) !== null,
  ) ? "active" : "inactive";
}

const SEMANTIC_BLOCK_NAMES = new Set([
  "Paragraph",
  "Task",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
  "SetextHeading1",
  "SetextHeading2",
]);

interface BlockTarget {
  node: SyntaxNode;
  item: SyntaxNode | null;
  selectionIndices: number[];
}

function isSemanticBlock(node: SyntaxNode): boolean {
  return SEMANTIC_BLOCK_NAMES.has(node.name);
}

function containingListItem(node: SyntaxNode): SyntaxNode | null {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.name === "ListItem") return parent;
  }
  return null;
}

function firstSemanticDescendant(node: SyntaxNode): SyntaxNode | null {
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (isSemanticBlock(child)) return child;
    const nested = firstSemanticDescendant(child);
    if (nested) return nested;
  }
  return null;
}

function effectiveSelectionEnd(state: EditorState, range: SelectionRange): number {
  if (range.empty || range.to === 0 || range.to === state.doc.length) return range.to;
  return state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to;
}

function selectionHasText(state: EditorState, range: SelectionRange): boolean {
  if (range.empty) return state.doc.lineAt(range.head).text.trim().length > 0;
  return state.doc.sliceString(range.from, range.to).trim().length > 0;
}

function blockTargets(state: EditorState, tree: Tree, format: BlockFormat): BlockTarget[] {
  const targets: BlockTarget[] = [];
  const seen = new Set<string>();

  const add = (node: SyntaxNode, selectionIndex: number): void => {
    const item = containingListItem(node);
    const targetNode = format === "bulletedList" && item ? item : node;
    const key = `${targetNode.from}:${targetNode.to}`;
    if (seen.has(key)) {
      const existing = targets.find((target) => {
        const candidate = format === "bulletedList" && target.item ? target.item : target.node;
        return candidate.from === targetNode.from && candidate.to === targetNode.to;
      });
      if (existing && !existing.selectionIndices.includes(selectionIndex)) {
        existing.selectionIndices.push(selectionIndex);
      }
      return;
    }
    seen.add(key);
    targets.push({
      node: format === "bulletedList" && item ? node : targetNode,
      item,
      selectionIndices: [selectionIndex],
    });
  };

  state.selection.ranges.forEach((range, selectionIndex) => {
    if (!selectionHasText(state, range)) return;
    const end = effectiveSelectionEnd(state, range);
    const visitTo = Math.min(state.doc.length, Math.max(range.from + 1, end + 1));
    tree.iterate({
      from: range.from,
      to: visitTo,
      enter(ref) {
        if (!isSemanticBlock(ref.node)) return;
        const touches = range.empty
          ? ref.from <= range.head && ref.to >= range.head
          : ref.from <= end && ref.to > range.from;
        if (touches) add(ref.node, selectionIndex);
        return false;
      },
    });

    if (targets.some((target) => target.selectionIndices.includes(selectionIndex))) return;
    const line = state.doc.lineAt(range.head);
    const side = range.head === line.from && range.head < state.doc.length ? 1 : -1;
    let resolved: SyntaxNode | null = tree.resolveInner(range.head, side);
    while (resolved && !isSemanticBlock(resolved)) {
      const descendant = firstSemanticDescendant(resolved);
      if (descendant) {
        add(descendant, selectionIndex);
        return;
      }
      resolved = resolved.parent;
    }
    if (resolved) add(resolved, selectionIndex);
  });

  return targets.sort((a, b) => {
    const aNode = format === "bulletedList" && a.item ? a.item : a.node;
    const bNode = format === "bulletedList" && b.item ? b.item : b.node;
    return aNode.from - bNode.from || aNode.to - bNode.to;
  });
}

function directChildren(node: SyntaxNode, name: string): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === name) children.push(child);
  }
  return children;
}

function headingContent(state: EditorState, node: SyntaxNode): ChangeSpan {
  const marks = directChildren(node, "HeaderMark");
  if (node.name.startsWith("SetextHeading")) {
    const underline = marks[0];
    const to = underline
      ? state.doc.line(state.doc.lineAt(underline.from).number - 1).to
      : node.to;
    return { from: node.from, to };
  }
  const opening = marks[0];
  const closing = marks.length > 1 ? marks[marks.length - 1] : null;
  let from = opening?.to ?? node.from;
  while (from < node.to && /[ \t]/.test(state.doc.sliceString(from, from + 1))) from += 1;
  return { from, to: closing?.from ?? node.to };
}

function listContentNode(item: SyntaxNode): SyntaxNode | null {
  for (let child = item.firstChild; child; child = child.nextSibling) {
    if (isSemanticBlock(child)) return child;
  }
  return firstSemanticDescendant(item);
}

function lastSemanticDescendant(node: SyntaxNode): SyntaxNode | null {
  for (let child = node.lastChild; child; child = child.prevSibling) {
    const nested = lastSemanticDescendant(child);
    if (nested) return nested;
    if (isSemanticBlock(child)) return child;
  }
  return null;
}

function quotePrefixLength(text: string): number {
  return /^(?: {0,3}>[ \t]?)+/.exec(text)?.[0].length ?? 0;
}

function visualColumn(text: string, to: number): number {
  let column = 0;
  for (let index = 0; index < to; index += 1) {
    column = text[index] === "\t" ? column + (4 - column % 4) : column + 1;
  }
  return column;
}

function continuationPrefix(state: EditorState, target: BlockTarget): string {
  const line = state.doc.lineAt(target.node.from);
  const prefix = state.doc.sliceString(line.from, target.node.from).split("");
  for (let item = containingListItem(target.node); item; item = containingListItem(item)) {
    const mark = item.getChild("ListMark");
    if (!mark || mark.from < line.from || mark.to > target.node.from) continue;
    for (let pos = mark.from; pos < mark.to; pos += 1) prefix[pos - line.from] = " ";
  }
  return prefix.join("");
}

function headingChanges(state: EditorState, target: BlockTarget, remove: boolean): ChangeSpec[] {
  const { node } = target;
  const marks = directChildren(node, "HeaderMark");
  const closing = marks.length > 1 ? marks[marks.length - 1] : null;
  const closingFrom = closing && closing.from > node.from &&
    /[ \t]/.test(state.doc.sliceString(closing.from - 1, closing.from))
    ? closing.from - 1
    : closing?.from;
  if (remove) {
    if (node.name === "ATXHeading1") {
      const content = headingContent(state, node);
      const changes: ChangeSpec[] = [{ from: marks[0]?.from ?? node.from, to: content.from }];
      if (closing && closingFrom !== undefined) {
        changes.push({ from: closingFrom, to: closing.to });
      }
      return changes;
    }
    if (node.name === "SetextHeading1" && marks[0]) {
      const underline = state.doc.lineAt(marks[0].from);
      const contentLine = state.doc.line(underline.number - 1);
      const nextLine = underline.number < state.doc.lines
        ? state.doc.line(underline.number + 1)
        : null;
      return nextLine?.text.trim()
        ? [{ from: underline.from, to: underline.to }]
        : [{ from: contentLine.to, to: underline.to }];
    }
    return [];
  }

  if (node.name.startsWith("ATXHeading")) {
    const content = headingContent(state, node);
    const changes: ChangeSpec[] = [
      { from: marks[0]?.from ?? node.from, to: content.from, insert: "# " },
    ];
    if (closing && closingFrom !== undefined) {
      changes.push({ from: closingFrom, to: closing.to });
    }
    return changes;
  }
  if (node.name === "SetextHeading2" && marks[0]) {
    return [{ from: marks[0].from, to: marks[0].to, insert: "===" }];
  }
  if (node.name === "ATXHeading1" || node.name === "SetextHeading1") return [];

  const firstLine = state.doc.lineAt(node.from);
  const lastLine = state.doc.lineAt(node.to);
  if (firstLine.number === lastLine.number) return [{ from: node.from, insert: "# " }];
  return [{
    from: lastLine.to,
    insert: `${state.lineBreak}${continuationPrefix(state, target)}===`,
  }];
}

interface ListInfo {
  item: SyntaxNode;
  mark: SyntaxNode;
  content: SyntaxNode;
}

function listInfo(target: BlockTarget): ListInfo | null {
  const item = target.item;
  const mark = item?.getChild("ListMark") ?? null;
  const content = item ? listContentNode(item) : null;
  return item && mark && content ? { item, mark, content } : null;
}

function continuationIndentChanges(
  state: EditorState,
  info: ListInfo,
  newWidth: number,
): ChangeSpec[] {
  const firstLine = state.doc.lineAt(info.mark.from);
  const firstText = firstLine.text;
  const firstQuote = quotePrefixLength(firstText);
  const outerWidth = Math.max(0, info.mark.from - firstLine.from - firstQuote);
  const oldWidth = visualColumn(firstText, info.content.from - firstLine.from) -
    visualColumn(firstText, info.mark.from - firstLine.from);
  if (newWidth === oldWidth) return [];

  const changes: ChangeSpec[] = [];
  const lastNumber = state.doc.lineAt(Math.max(info.item.from, info.item.to - 1)).number;
  for (let number = firstLine.number + 1; number <= lastNumber; number += 1) {
    const line = state.doc.line(number);
    if (line.text.trim().length === 0) continue;
    const quote = quotePrefixLength(line.text);
    const editAt = line.from + quote + outerWidth;
    let removeTo = editAt;
    const startColumn = visualColumn(line.text, quote + outerWidth);
    while (
      removeTo < line.to &&
      visualColumn(line.text, removeTo - line.from) - startColumn < oldWidth &&
      /[ \t]/.test(state.doc.sliceString(removeTo, removeTo + 1))
    ) removeTo += 1;
    const consumed = visualColumn(line.text, removeTo - line.from) - startColumn;
    if (consumed >= oldWidth) {
      changes.push({ from: editAt, to: removeTo, insert: " ".repeat(newWidth) });
    }
  }
  return changes;
}

function plainListChanges(state: EditorState, target: BlockTarget): ChangeSpec[] {
  const changes: ChangeSpec[] = [{ from: target.node.from, insert: "- " }];
  const firstLine = state.doc.lineAt(target.node.from);
  const lastNumber = state.doc.lineAt(Math.max(target.node.from, target.node.to - 1)).number;
  const firstQuote = quotePrefixLength(firstLine.text);
  const outerWidth = Math.max(0, target.node.from - firstLine.from - firstQuote);
  for (let number = firstLine.number + 1; number <= lastNumber; number += 1) {
    const line = state.doc.line(number);
    if (line.text.trim().length === 0) continue;
    const quote = quotePrefixLength(line.text);
    changes.push({ from: line.from + quote + outerWidth, insert: "  " });
  }
  return changes;
}

function previousListBlock(item: SyntaxNode): SyntaxNode | null {
  for (let previous = item.prevSibling; previous; previous = previous.prevSibling) {
    if (previous.name === "ListItem") return previous;
  }
  for (let previous = item.parent?.prevSibling ?? null; previous; previous = previous.prevSibling) {
    if (isSemanticBlock(previous)) return previous;
    const nested = lastSemanticDescendant(previous);
    if (nested) return nested;
  }
  return null;
}

function needsListSeparator(state: EditorState, item: SyntaxNode): boolean {
  const previous = previousListBlock(item);
  if (!previous) return false;
  const previousLine = state.doc.lineAt(Math.max(previous.from, previous.to - 1)).number;
  return state.doc.lineAt(item.from).number === previousLine + 1;
}

function hasSelectedListAncestor(item: SyntaxNode, selectedItems: ReadonlySet<string>): boolean {
  for (let parent = item.parent; parent; parent = parent.parent) {
    if (parent.name === "ListItem" && selectedItems.has(`${parent.from}:${parent.to}`)) return true;
  }
  return false;
}

function listChanges(
  state: EditorState,
  targets: readonly BlockTarget[],
  remove: boolean,
): ChangeSpec[] {
  const selectedItems = new Set(targets.flatMap((target) => {
    const item = listInfo(target)?.item;
    return item ? [`${item.from}:${item.to}`] : [];
  }));
  return targets.flatMap((target) => {
    const info = listInfo(target);
    if (!info) return remove ? [] : plainListChanges(state, target);
    if (!remove && info.item.parent?.name === "BulletList" &&
      state.doc.sliceString(info.mark.from, info.content.from) === "- ") return [];

    let markerChange: ChangeSpec = {
      from: info.mark.from,
      to: info.content.from,
      insert: remove ? "" : "- ",
    };
    if (remove && needsListSeparator(state, info.item)) {
      const line = state.doc.lineAt(info.mark.from);
      const quoteEnd = line.from + quotePrefixLength(line.text);
      const quotePrefix = state.doc.sliceString(line.from, quoteEnd);
      const authoredPrefix = state.doc.sliceString(line.from, info.mark.from);
      markerChange = hasSelectedListAncestor(info.item, selectedItems)
        ? { from: info.mark.from, to: info.content.from, insert: state.lineBreak + quotePrefix }
        : { from: quoteEnd, to: info.content.from, insert: state.lineBreak + authoredPrefix };
    }
    return [
      markerChange,
      ...continuationIndentChanges(state, info, remove ? 0 : 2),
    ];
  });
}

interface LogicalBlockContent {
  node: SyntaxNode;
  firstFrom: number;
}

function logicalBlockContent(
  state: EditorState,
  target: BlockTarget,
  format: BlockFormat,
): LogicalBlockContent {
  if (format === "heading1") {
    return { node: target.node, firstFrom: headingContent(state, target.node).from };
  }
  const content = listInfo(target)?.content ?? target.node;
  return { node: content, firstFrom: content.from };
}

function skipIndentColumns(text: string, from: number, width: number): number {
  let offset = from;
  let column = visualColumn(text, from);
  const target = column + width;
  while (offset < text.length && column < target && /[ \t]/.test(text[offset])) {
    column = text[offset] === "\t" ? column + (4 - column % 4) : column + 1;
    offset += 1;
  }
  return offset;
}

function logicalContentFromOnLine(
  state: EditorState,
  target: BlockTarget,
  format: BlockFormat,
  lineNumber: number,
): number | null {
  const content = logicalBlockContent(state, target, format);
  const firstLine = state.doc.lineAt(content.node.from);
  const lastLine = state.doc.lineAt(Math.max(content.node.from, content.node.to - 1));
  if (lineNumber < firstLine.number || lineNumber > lastLine.number) return null;
  if (lineNumber === firstLine.number) return content.firstFrom;

  const firstQuote = quotePrefixLength(firstLine.text);
  const containerWidth = visualColumn(firstLine.text, content.node.from - firstLine.from) -
    visualColumn(firstLine.text, firstQuote);
  const line = state.doc.line(lineNumber);
  const quote = quotePrefixLength(line.text);
  return line.from + skipIndentColumns(line.text, quote, containerWidth);
}

function logicalSpanFrom(
  state: EditorState,
  span: ChangeSpan,
  sourceIndex: number,
  format: BlockFormat,
  targets: readonly BlockTarget[],
): number {
  const lineNumber = state.doc.lineAt(span.from).number;
  const candidates = targets
    .filter((target) => target.selectionIndices.includes(sourceIndex))
    .map((target) => ({ target, from: logicalContentFromOnLine(state, target, format, lineNumber) }))
    .filter((candidate): candidate is { target: BlockTarget; from: number } => candidate.from !== null)
    .sort((a, b) => b.target.node.from - a.target.node.from || a.target.node.to - b.target.node.to);
  return Math.max(span.from, candidates[0]?.from ?? span.from);
}

function blockLogicalSelection(
  state: EditorState,
  changes: ChangeSet,
  format: BlockFormat,
  targets: readonly BlockTarget[],
): EditorSelection {
  const entries: Array<{ range: SelectionRange; sourceIndex: number }> = [];
  state.selection.ranges.forEach((source, sourceIndex) => {
    const backward = source.anchor > source.head;
    const spans: ChangeSpan[] = [];
    if (source.empty) {
      spans.push({ from: source.head, to: source.head });
    } else {
      const last = effectiveSelectionEnd(state, source);
      const firstLine = state.doc.lineAt(source.from).number;
      const lastLine = state.doc.lineAt(last).number;
      const splitLines = format === "bulletedList" || Array.from(
        { length: lastLine - firstLine + 1 },
        (_, index) => firstLine + index,
      ).some((number) => {
        const line = state.doc.line(number);
        return logicalSpanFrom(
          state,
          { from: Math.max(source.from, line.from), to: Math.min(source.to, line.to) },
          sourceIndex,
          format,
          targets,
        ) > Math.max(source.from, line.from);
      });
      if (splitLines) {
        for (let number = firstLine; number <= lastLine; number += 1) {
          const line = state.doc.line(number);
          const from = Math.max(source.from, line.from);
          const to = Math.min(source.to, line.to);
          if (from < to) spans.push({ from, to });
        }
      } else {
        spans.push({ from: source.from, to: source.to });
      }
    }

    const mapped = spans.flatMap((span) => {
      const logicalFrom = logicalSpanFrom(state, span, sourceIndex, format, targets);
      const from = changes.mapPos(logicalFrom, 1);
      const to = changes.mapPos(span.to, -1);
      if (from > to) return [];
      return [backward ? EditorSelection.range(to, from) : EditorSelection.range(from, to)];
    });
    if (mapped.some((range) => !range.empty) || source.empty) {
      entries.push(...mapped.map((range) => ({ range, sourceIndex })));
      return;
    }

    const target = targets.find((candidate) => candidate.selectionIndices.includes(sourceIndex));
    if (!target) return;
    const info = listInfo(target);
    const content = info?.content ?? target.node;
    const from = changes.mapPos(content.from, 1);
    const to = changes.mapPos(content.to, -1);
    entries.push({
      range: backward ? EditorSelection.range(to, from) : EditorSelection.range(from, to),
      sourceIndex,
    });
  });

  const unique = entries.filter((entry, index) =>
    index === 0 ||
    entry.range.from !== entries[index - 1].range.from ||
    entry.range.to !== entries[index - 1].range.to,
  );
  const mainSource = state.selection.mainIndex;
  const mainCandidates = unique.flatMap((entry, index) =>
    entry.sourceIndex === mainSource ? [index] : []
  );
  const mainIndex = Math.max(0, state.selection.main.anchor <= state.selection.main.head
    ? mainCandidates[mainCandidates.length - 1] ?? 0
    : mainCandidates[0] ?? 0);
  return EditorSelection.create(unique.map((entry) => entry.range), mainIndex);
}

function blockIsActive(target: BlockTarget, format: BlockFormat): boolean {
  if (format === "heading1") {
    return target.node.name === "ATXHeading1" || target.node.name === "SetextHeading1";
  }
  return target.item?.parent?.name === "BulletList";
}

function prepareBlockCommand(
  state: EditorState,
  format: BlockFormat,
  tree: Tree,
): PreparedFormatCommand {
  if (
    state.readOnly ||
    state.selection.ranges.some((range) => excludedByCriticMarkup(state, range.from, range.to))
  ) return { status: "unchanged" };

  const targets = blockTargets(state, tree, format);
  if (targets.length === 0) return { status: "unchanged" };
  const remove = targets.every((target) => blockIsActive(target, format));
  const specs = format === "heading1"
    ? targets.flatMap((target) => headingChanges(state, target, remove))
    : listChanges(state, targets, remove);
  if (specs.length === 0) return { status: "unchanged" };
  const changes = state.changes(specs);
  if (changes.empty || editsCriticDelimiter(state, changes)) return { status: "unchanged" };
  const geometry = formattingGeometryEffect(state, changes);
  return {
    status: "ready",
    transaction: {
      changes,
      selection: blockLogicalSelection(state, changes, format, targets),
      effects: geometry ? [geometry] : [],
      annotations: isolateHistory.of("full"),
      userEvent: format === "heading1" ? "input.format.heading1" : "input.format.bulletedList",
    },
  };
}

function runBlockFormat(view: EditorView, format: BlockFormat): FormatCommandResult {
  if (view.state.readOnly) return { status: "unchanged" };
  const maxTo = Math.max(...view.state.selection.ranges.map((range) => range.to));
  const tree = parsedTreeForActiveRead(view.state, maxTo);
  if (!tree || !blockTargetsArePublished(view.state, tree, format)) {
    return { status: "pending" };
  }
  const exclusion = firstExclusion(view.state, tree, format);
  if (exclusion) return unavailableResult(format, exclusion.region);
  const prepared = prepareBlockCommand(view.state, format, tree);
  if (prepared.status === "unchanged") return prepared;
  const transaction = view.state.update(prepared.transaction);
  if (
    transaction.startState.field(historyField, false) &&
    transaction.selection &&
    !transaction.selection.eq(view.state.selection.map(transaction.changes))
  ) {
    // CM6 records the selection before a document transaction. A same-selection receipt is folded
    // into that history event, so redo restores this transaction's disjoint authored ranges too.
    const selectionReceipt = transaction.state.update({ selection: transaction.state.selection });
    view.dispatch([transaction, selectionReceipt]);
  } else {
    view.dispatch(transaction);
  }
  return { status: "applied" };
}

function blockFormatStatus(
  state: EditorState,
  format: BlockFormat,
  tree: Tree,
): FormatControlStatus {
  if (state.selection.ranges.some((range) => rangeUnavailable(state, tree, range, format))) {
    return "inactive";
  }
  const targets = blockTargets(state, tree, format);
  return targets.length > 0 && targets.every((target) => blockIsActive(target, format))
    ? "active"
    : "inactive";
}

function blockTargetsArePublished(
  state: EditorState,
  tree: Tree,
  format: BlockFormat,
): boolean {
  const targets = blockTargets(state, tree, format);
  if (targets.length === 0) return true;
  const targetTo = Math.max(...targets.map((target) =>
    format === "bulletedList" && target.item ? target.item.to : target.node.to,
  ));
  const proofTo = targetTo < state.doc.length ? targetTo + 1 : targetTo;
  return syntaxTreeAvailable(state, proofTo);
}

/** Enables CM6's native disjoint ranges for selections whose semantic inline containers are
 * separated by Markdown scaffolding (blank lines, table delimiters, or task markers). */
export function formatCommandExtensions(): Extension[] {
  return [EditorState.allowMultipleSelections.of(true)];
}

/** Reports the semantic pressed state only from the tree CodeMirror has published for this
 * document revision and target. A pending result asks the UI to retain its neutral visual state
 * until the language worker publishes authoritative coverage. */
export function formatControlStates(state: EditorState): FormatControlStates {
  const maxTo = Math.max(...state.selection.ranges.map((range) => range.to));
  const tree = parsedTreeForActiveRead(state, maxTo);
  if (!tree) {
    return {
      bold: "pending",
      italic: "pending",
      heading1: "pending",
      bulletedList: "pending",
    };
  }
  return {
    bold: inlineFormatStatus(state, "bold", tree),
    italic: inlineFormatStatus(state, "italic", tree),
    heading1: blockTargetsArePublished(state, tree, "heading1")
      ? blockFormatStatus(state, "heading1", tree)
      : "pending",
    bulletedList: blockTargetsArePublished(state, tree, "bulletedList")
      ? blockFormatStatus(state, "bulletedList", tree)
      : "pending",
  };
}

export function toggleBold(view: EditorView): FormatCommandResult {
  return runInlineFormat(view, "bold");
}

export function toggleItalic(view: EditorView): FormatCommandResult {
  return runInlineFormat(view, "italic");
}

export function toggleHeading1(view: EditorView): FormatCommandResult {
  return runBlockFormat(view, "heading1");
}

export function toggleBulletedList(view: EditorView): FormatCommandResult {
  return runBlockFormat(view, "bulletedList");
}
