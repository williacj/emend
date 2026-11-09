// ABOUTME: The base card shell every timeline card kind renders through (§3.1 `timeline/`) — a
// ABOUTME: stable header/body/footer slot contract other units extend without editing this file.
import { useRef, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from "react";

export interface TimelineCardProps {
  /** Card identity, mirrored to `data-card-id` so tests/tools can select a card without parsing
   * rendered text. */
  id: string;
  /** Card kind discriminant (`TimelineCard["kind"]`), mirrored to `data-card-kind` — the seam
   * P2b-1's facet filtering reads from later, not implemented by this unit. */
  kind: string;
  /** Typically author/title + timestamp; omitted entirely if a variant has no header content. */
  header?: ReactNode;
  /** The card's primary content. */
  children: ReactNode;
  /** Trailing region — e.g. a severity chip (`● H`) or status line; omitted if unused. */
  footer?: ReactNode;
  /** P2b-1b's collapsed single-line render: swaps in the tighter `.timeline-card--collapsed` shell
   * instead of the default one. The base chrome (margin + padding + border, `styles.css`) alone
   * consumes most of `collapse.ts`'s `COLLAPSED_ITEM_HEIGHT` (32px) budget before any content, so a
   * collapsed card needs a shell sized to actually fit within it rather than the roomier default one
   * every expanded card uses (review finding, PR #481). Defaults to `false` — every existing caller
   * is unaffected. */
  compact?: boolean;
  /** Makes this card the programmatic J9 navigation destination without adding it to Tab order. */
  focusTargetRef?: Ref<HTMLElement>;
  /** 4g's outer ring on a submitted turn, distinct from J9's inset navigation ring. */
  submittedTurnLanding?: boolean;
  /** Optional spatial comment-column activation; nested action controls keep their own meaning. */
  onActivate?: () => void;
  activationLabel?: string;
  selected?: boolean;
}

function isActionTarget(target: EventTarget | null, card: HTMLElement): boolean {
  return target instanceof Element && target !== card && Boolean(
    target.closest("button, a, input, textarea, select, summary, [role='button']"),
  );
}

/**
 * Renders the chrome shared by every card kind. Variants (chat message, change-set, comment,
 * agent activity…) compose this component rather than reimplementing card structure, and new
 * kinds are added by writing a new variant + a case in `TimelinePanel`'s render-switch — never by
 * changing this component's props or markup.
 */
export function TimelineCard({
  id,
  kind,
  header,
  children,
  footer,
  compact = false,
  focusTargetRef,
  submittedTurnLanding = false,
  onActivate,
  activationLabel,
  selected = false,
}: TimelineCardProps) {
  const pointerEditorFocus = useRef<HTMLElement | null>(null);
  const activateOnPointer = (event: MouseEvent<HTMLElement>) => {
    const restoreFocus = pointerEditorFocus.current;
    pointerEditorFocus.current = null;
    if (!onActivate || isActionTarget(event.target, event.currentTarget)) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString()
      && selection.anchorNode && selection.focusNode
      && event.currentTarget.contains(selection.anchorNode)
      && event.currentTarget.contains(selection.focusNode)) return;
    onActivate();
    restoreFocus?.focus({ preventScroll: true });
  };
  const activateOnKey = (event: KeyboardEvent<HTMLElement>) => {
    if (!onActivate || event.target !== event.currentTarget || !["Enter", " "].includes(event.key)) return;
    pointerEditorFocus.current = null;
    event.preventDefault();
    onActivate();
  };
  return (
    <article
      ref={focusTargetRef}
      className={
        `${compact ? "timeline-card timeline-card--collapsed" : "timeline-card"}`
        + (focusTargetRef ? " timeline-card--focus-target" : "")
        + (submittedTurnLanding ? " timeline-card--submitted-turn" : "")
      }
      data-card-id={id}
      data-card-kind={kind}
      aria-current={selected ? "true" : undefined}
      aria-label={onActivate ? activationLabel ?? "Select comment thread" : undefined}
      tabIndex={focusTargetRef ? -1 : onActivate ? 0 : undefined}
      onMouseDown={(event) => {
        pointerEditorFocus.current = onActivate && event.button === 0
          && !isActionTarget(event.target, event.currentTarget)
          && document.activeElement instanceof HTMLElement
          && document.activeElement.closest(".cm-editor")
          ? document.activeElement : null;
      }}
      onClick={activateOnPointer}
      onKeyDown={activateOnKey}
    >
      {header !== undefined && <header className="timeline-card__header">{header}</header>}
      <div className="timeline-card__body">{children}</div>
      {footer !== undefined && <footer className="timeline-card__footer">{footer}</footer>}
    </article>
  );
}
