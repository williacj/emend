// ABOUTME: Resolves a recorded passage against the live editor buffer before moving its selection.
// ABOUTME: Shared by timeline and comment-popover navigation through both document pane types.
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Anchor, CommentThread } from "../comments/types";
import { editorOffsetText } from "./document";
import { resolveAnchor } from "./ipc";
import { commentAnchors, setSelectedCommentThread } from "./commentHighlights";

/** Reveals a column thread's live mapped passage without moving the caret or taking focus. */
export async function revealCommentThreadInEditor(
  view: EditorView | null,
  thread: Pick<CommentThread, "id" | "anchor" | "withdrawn_at">,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  if (!view || !isCurrent()) return false;
  const live = commentAnchors(view.state).find((anchor) => anchor.threadId === thread.id);
  if (!live && (thread.withdrawn_at == null || !thread.anchor)) return false;
  let from = live?.from;
  if (from === undefined && thread.anchor) {
    // A withdrawn placeholder deliberately has no live highlight or gutter, but J10 retains its
    // passage route. Resolve its recorded quote against the current buffer before making a claim.
    const content = editorOffsetText(view.state);
    const position = await resolveAnchor(content, thread.anchor).catch(() => null);
    if (!position || editorOffsetText(view.state) !== content) return false;
    from = position.from;
  }
  if (from === undefined || !isCurrent()) return false;
  view.dispatch({
    effects: [
      setSelectedCommentThread.of(live ? thread.id : null),
      EditorView.scrollIntoView(from, { y: "center" }),
    ],
  });
  return true;
}

export async function focusAnchorInEditor(view: EditorView | null, anchor: Anchor): Promise<boolean> {
  if (!view) return false;
  const content = editorOffsetText(view.state);
  const position = await resolveAnchor(content, anchor).catch(() => null);
  // The source may change while the resolver is in flight. Never select a stale range.
  if (!position || editorOffsetText(view.state) !== content) return false;
  // Moving focus out of a popover can restore the browser's old DOM caret; focus first so the
  // resolved range is the final selection applied to the editor.
  view.focus();
  view.dispatch({
    selection: EditorSelection.range(position.from, position.to),
    effects: EditorView.scrollIntoView(position.from, { y: "center" }),
  });
  return true;
}
