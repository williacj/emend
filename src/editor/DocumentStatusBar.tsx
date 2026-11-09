// ABOUTME: UXR-Q7.2's reusable one-row document status bar, with leading/trailing slots and
// ABOUTME: measured right-edge overflow shared by file-backed and pathless authoring panes.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Ellipsis } from "lucide-react";
import { useDismissOnOutsideOrEscape } from "../useDismissOnOutsideOrEscape";
import { isMac } from "./keymap";

export type DocumentStatusBarPlatform = "win" | "mac";

export interface DocumentStatusBarItem {
  /** Stable identity used to track the item across the row and its overflow entry. */
  id: string;
  /** The item's complete visible control or readout. */
  content: ReactNode;
  /** Complete text for a readout that may be clipped in a narrow column. */
  accessibleLabel?: string;
}

interface DocumentStatusBarOverflowEntryBase {
  /** Stable identity within its parent status item. */
  id: string;
  /** Visible and accessible menu-entry label. */
  label: string;
  /** When supplied, exposes the entry as one choice in a radio-menu control. */
  checked?: boolean;
}

export type DocumentStatusBarOverflowEntry = DocumentStatusBarOverflowEntryBase &
  (
    | { onSelect: () => void; disabled?: false }
    | { onSelect?: never; disabled: true }
  );

export interface DocumentStatusBarTrailingItem extends DocumentStatusBarItem {
  /** One or more complete actions preserving the control's semantics while it is overflowed. */
  overflowEntries: readonly [DocumentStatusBarOverflowEntry, ...DocumentStatusBarOverflowEntry[]];
}

export interface DocumentStatusBarProps {
  /** Left-cluster facts. They always remain in the row and are never candidates for overflow. */
  leadingItems?: readonly DocumentStatusBarItem[];
  /**
   * Right-cluster controls/readouts in survival order: the first item remains longest and items
   * collapse from the array's trailing edge. This makes the caller's priority explicit while
   * matching authoring-shell.md's "agent connection first" removal rule for its eventual
   * `[display, saved, connection]` composition.
   */
  trailingItems?: readonly DocumentStatusBarTrailingItem[];
  /** Defaults to the running platform; injectable for exact Windows/macOS presentation tests. */
  platform?: DocumentStatusBarPlatform;
}

const STATUS_GAP_PX = 14;
const OVERFLOW_BUTTON_WIDTH_PX = 28;
const EMPTY_ITEMS: readonly DocumentStatusBarTrailingItem[] = [];

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

export function DocumentStatusBar({
  leadingItems = EMPTY_ITEMS,
  trailingItems = EMPTY_ITEMS,
  platform = isMac ? "mac" : "win",
}: DocumentStatusBarProps) {
  const barRef = useRef<HTMLElement>(null);
  const leadingRef = useRef<HTMLDivElement>(null);
  const overflowMeasureRef = useRef<HTMLSpanElement>(null);
  const trailingElements = useRef(new Map<string, HTMLSpanElement>());
  const overflowMeasureElements = useRef(new Map<string, HTMLSpanElement>());
  const overflowEntryElements = useRef(new Map<string, HTMLDivElement>());
  const trailingWidths = useRef(new Map<string, number>());
  const itemIdentity = trailingItems.map((item) => item.id).join("\u0000");
  const previousIdentity = useRef(itemIdentity);
  const [visibleTrailingCount, setVisibleTrailingCount] = useState(trailingItems.length);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const requestedMenuEdge = useRef<"first" | "last">("first");

  useDismissOnOutsideOrEscape(overflowOpen, overflowRef, setOverflowOpen);

  const measure = useCallback(() => {
    const bar = barRef.current;
    const leading = leadingRef.current;
    if (!bar || !leading || bar.clientWidth <= 0) return;

    const measurableElements = new Map(trailingElements.current);
    for (const [id, element] of overflowMeasureElements.current) measurableElements.set(id, element);
    for (const [id, element] of measurableElements) {
      if (element.offsetWidth > 0) trailingWidths.current.set(id, element.offsetWidth);
    }
    const widths = trailingItems.map((item) => trailingWidths.current.get(item.id) ?? 0);
    // A zero means a newly supplied item has not had a painted all-visible pass yet. Keep it in
    // the row for that pass; otherwise treating it as free could hide the wrong trailing sibling.
    if (widths.some((width) => width <= 0)) return;

    const computed = getComputedStyle(bar);
    const horizontalPadding =
      (Number.parseFloat(computed.paddingLeft) || 0) +
      (Number.parseFloat(computed.paddingRight) || 0);
    const available = Math.max(0, bar.clientWidth - horizontalPadding);
    const leadingWidth = leading.scrollWidth;
    const outerGap = leadingItems.length > 0 && trailingItems.length > 0 ? STATUS_GAP_PX : 0;
    const allTrailingWidth =
      sum(widths) + Math.max(0, trailingItems.length - 1) * STATUS_GAP_PX;

    if (leadingWidth + outerGap + allTrailingWidth <= available) {
      setVisibleTrailingCount(trailingItems.length);
      return;
    }

    const overflowWidth = overflowMeasureRef.current?.offsetWidth || OVERFLOW_BUTTON_WIDTH_PX;
    let count = trailingItems.length;
    while (count > 0) {
      count -= 1;
      const visibleWidth = sum(widths.slice(0, count));
      const visibleGaps = Math.max(0, count - 1) * STATUS_GAP_PX;
      const overflowGap = count > 0 ? STATUS_GAP_PX : 0;
      const required =
        leadingWidth +
        outerGap +
        visibleWidth +
        visibleGaps +
        overflowGap +
        overflowWidth;
      if (required <= available) break;
    }
    setVisibleTrailingCount(count);
  }, [leadingItems.length, trailingItems]);

  // A changed slot identity gets one all-visible render so every new item's real rendered width is
  // observed before any overflow decision. Width-only content changes are picked up on every
  // commit for whichever items are still in the row; cached hidden widths support restoration.
  useLayoutEffect(() => {
    if (previousIdentity.current !== itemIdentity) {
      previousIdentity.current = itemIdentity;
      trailingWidths.current.clear();
      if (visibleTrailingCount !== trailingItems.length) {
        setVisibleTrailingCount(trailingItems.length);
        return;
      }
    }
    measure();
  });

  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    if (leadingRef.current) observer.observe(leadingRef.current);
    for (const element of trailingElements.current.values()) observer.observe(element);
    for (const element of overflowMeasureElements.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [measure, visibleTrailingCount]);

  const hiddenItems = trailingItems.slice(visibleTrailingCount);
  const leadingLabel = leadingItems
    .map((item) => item.accessibleLabel ?? (typeof item.content === "string" ? item.content : ""))
    .filter(Boolean)
    .join(" · ");
  const overflowEntries = hiddenItems.flatMap((item) =>
    item.overflowEntries.map((entry) => ({
      key: `${item.id}\u0000${entry.id}`,
      entry,
    })),
  );
  const overflowEntryIdentity = overflowEntries.map(({ key }) => key).join("\u0001");
  useEffect(() => {
    if (hiddenItems.length === 0) setOverflowOpen(false);
  }, [hiddenItems.length]);

  useLayoutEffect(() => {
    if (!overflowOpen) return;
    const items = overflowEntries
      .map(({ key }) => overflowEntryElements.current.get(key))
      .filter((item): item is HTMLDivElement => Boolean(item));
    const target = requestedMenuEdge.current === "last" ? items[items.length - 1] : items[0];
    target?.focus();
  }, [overflowEntryIdentity, overflowOpen]);

  const openOverflow = (edge: "first" | "last") => {
    requestedMenuEdge.current = edge;
    if (overflowOpen) {
      const candidate =
        edge === "last" ? overflowEntries[overflowEntries.length - 1] : overflowEntries[0];
      if (candidate) overflowEntryElements.current.get(candidate.key)?.focus();
      return;
    }
    setOverflowOpen(true);
  };

  const closeOverflowAndRestoreFocus = () => {
    setOverflowOpen(false);
    overflowTriggerRef.current?.focus();
  };

  const selectOverflowEntry = (entry: DocumentStatusBarOverflowEntry) => {
    if (entry.disabled || !entry.onSelect) return;
    try {
      entry.onSelect();
    } finally {
      closeOverflowAndRestoreFocus();
    }
  };

  const handleOverflowItemKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null;
    switch (event.key) {
      case "ArrowDown":
        nextIndex = (index + 1) % overflowEntries.length;
        break;
      case "ArrowUp":
        nextIndex = (index - 1 + overflowEntries.length) % overflowEntries.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = overflowEntries.length - 1;
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        selectOverflowEntry(overflowEntries[index].entry);
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        closeOverflowAndRestoreFocus();
        return;
      default:
        return;
    }
    event.preventDefault();
    const nextEntry = overflowEntries[nextIndex];
    overflowEntryElements.current.get(nextEntry.key)?.focus();
  };

  return (
    <footer
      ref={barRef}
      className="document-status-bar"
      role="region"
      aria-label="Document status"
      data-platform={platform}
    >
      <div
        className="document-status-bar__leading"
        ref={leadingRef}
        role="group"
        aria-label={leadingLabel || undefined}
        title={leadingLabel || undefined}
      >
        {leadingItems.map((item) => {
          const label =
            item.accessibleLabel ?? (typeof item.content === "string" ? item.content : undefined);
          return (
            <span
              className="document-status-bar__leading-item"
              data-status-item-id={item.id}
              aria-label={label}
              title={label}
              key={item.id}
            >
              {item.content}
            </span>
          );
        })}
      </div>
      <div className="document-status-bar__trailing">
        {trailingItems.slice(0, visibleTrailingCount).map((item) => (
          <span
            className="document-status-bar__trailing-item"
            data-status-item-id={item.id}
            key={item.id}
            ref={(element) => {
              if (element) trailingElements.current.set(item.id, element);
              else trailingElements.current.delete(item.id);
            }}
          >
            {item.content}
          </span>
        ))}
        {hiddenItems.length > 0 && (
          <div className="document-status-bar__overflow" ref={overflowRef}>
            <button
              ref={overflowTriggerRef}
              type="button"
              aria-label="More document status"
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              onClick={() => {
                if (overflowOpen) setOverflowOpen(false);
                else openOverflow("first");
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                openOverflow(event.key === "ArrowUp" ? "last" : "first");
              }}
            >
              <Ellipsis aria-hidden="true" size={16} strokeWidth={1.75} />
            </button>
            <div
              className="document-status-bar__overflow-menu"
              role="menu"
              aria-label="More document status"
              aria-hidden={!overflowOpen}
            >
              {hiddenItems.map((item) => (
                <span
                  className="document-status-bar__overflow-item-measure"
                  data-status-item-id={item.id}
                  key={`measure-${item.id}`}
                  ref={(element) => {
                    if (element) overflowMeasureElements.current.set(item.id, element);
                    else overflowMeasureElements.current.delete(item.id);
                  }}
                  aria-hidden="true"
                  inert
                >
                  {item.content}
                </span>
              ))}
              {overflowEntries.map(({ key, entry }, index) => (
                <div
                  className="document-status-bar__overflow-item"
                  role={entry.checked === undefined ? "menuitem" : "menuitemradio"}
                  tabIndex={-1}
                  aria-checked={entry.checked}
                  aria-disabled={entry.disabled || undefined}
                  key={key}
                  ref={(element) => {
                    if (element) overflowEntryElements.current.set(key, element);
                    else overflowEntryElements.current.delete(key);
                  }}
                  onClick={() => selectOverflowEntry(entry)}
                  onKeyDown={(event) => handleOverflowItemKeyDown(event, index)}
                >
                  {entry.label}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <span
        className="document-status-bar__overflow-measure"
        ref={overflowMeasureRef}
        aria-hidden="true"
      >
        <Ellipsis aria-hidden="true" size={16} strokeWidth={1.75} />
      </span>
    </footer>
  );
}
