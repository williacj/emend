// ABOUTME: The chat-message card variant (§3.1 `timeline/`) — the first extension of the base
// ABOUTME: `TimelineCard` shell, rendering a user or agent message (FR-CHAT-1), plus (P2b-7) a
// ABOUTME: quoted editor excerpt that deep-links back to its anchored range (UX Principle 6).
import type { Anchor } from "../comments/types";
import { isMac } from "../editor/keymap";
import type { ChatMessageCard as ChatMessageCardData } from "./types";
import { TimelineCard } from "./TimelineCard";

export interface ChatMessageCardProps {
  card: ChatMessageCardData;
  /** Defaults to the running platform; injectable for exact 10a/10b tile-radius coverage. */
  platform?: "win" | "mac";
  /** Injectable clock for deterministic relative timestamps; defaults to the current time. */
  now?: () => number;
  /**
   * Called when the quoted excerpt's deep-link is clicked (P2b-7, Principle 6: "everything in the
   * panel deep-links into the text") — the caller scrolls the live editor to `anchor`'s range.
   * Never called automatically (no focus steal, Principle 2). Omitted in a caller with no live
   * editor yet (mirrors `ChangeSetCard`'s identical `onFocusChange`).
   */
  onFocusQuote?: (anchor: Anchor) => void;
}

const AUTHOR_LABEL: Record<ChatMessageCardData["author"], string> = {
  user: "You",
  agent: "Agent",
};

export function relativeTimestamp(timestamp: string, now: number): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
  if (elapsedSeconds < 60) return "now";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  return `${Math.floor(elapsedHours / 24)}d`;
}

export function ChatMessageCard({
  card,
  onFocusQuote,
  platform = isMac ? "mac" : "win",
  now = Date.now,
}: ChatMessageCardProps) {
  // J2's grounding affordance (Principle 3, #1391): `[refs: N files read]`, present only when the
  // run that produced this reply actually read something — see `ChatMessageCard.filesRead`'s own
  // docs for why a clarifying question needs no extra edge-case handling here.
  const showRefs = card.author === "agent" && (card.filesRead ?? 0) > 0;
  const { quote } = card;
  return (
    <TimelineCard
      id={card.id}
      kind={card.kind}
      header={
        <span className="chat-message-card__attribution" data-platform={platform}>
          {card.author === "agent" ? (
            <span
              className="chat-message-card__agent-tile"
              aria-hidden="true"
            />
          ) : (
            <span className="chat-message-card__user-avatar" aria-hidden="true" />
          )}
          <span className="chat-message-card__author">{AUTHOR_LABEL[card.author]}</span>
          <time className="chat-message-card__timestamp" dateTime={card.timestamp}>
            {relativeTimestamp(card.timestamp, now())}
          </time>
        </span>
      }
      footer={
        showRefs ? (
          <span className="chat-message-card__refs">
            refs: {card.filesRead} {card.filesRead === 1 ? "file" : "files"} read
          </span>
        ) : undefined
      }
    >
      {quote && (
        <blockquote className="chat-message-card__quote">
          {quote.documentPath === null ? (
            // J12 Phase E: a pathless quote's back-link is not merely unbuilt, it is unbuildable
            // today — TabbedEditor.focusAnchor resolves through editorHandles, which only the
            // file-backed EditorShell branch registers, so the untitled pane's own DocumentSurface
            // is never reachable through it. An affordance that always looks live and never
            // resolves is worse than none (Principle 7, FR-X-5), so the link is absent — the
            // quote itself stays, exactly as Phase E requires ("the quote remains as quoted text
            // and its back-link is absent, not broken"). Same class as the button below
            // (`CommentThreadCard`'s identical anchor-footer convention: one class, a `button.`
            // override adds only the interactive styles) so both read as italic, muted quoted
            // text (pinned in ChatMessageCard.test.tsx) — the button rule uses longhand `inherit`s
            // rather than the `font` shorthand precisely so it cannot reset that shared italic.
            <span className="chat-message-card__quote-link">“{quote.text}”</span>
          ) : (
            <button
              type="button"
              className="chat-message-card__quote-link"
              onClick={() => onFocusQuote?.(quote.anchor)}
            >
              “{quote.text}”
            </button>
          )}
        </blockquote>
      )}
      <p className="chat-message-card__body">{card.body}</p>
    </TimelineCard>
  );
}
