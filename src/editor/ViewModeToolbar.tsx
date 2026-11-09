// ABOUTME: Shared document toolbar for the Rich text/Markdown axis and J14 format controls.
// ABOUTME: It preserves semantic source targets, input-origin focus, and the one-row geometry.
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import type { EditorView } from "@codemirror/view";
import { Ellipsis } from "lucide-react";
import { beginAppStatusRequest, setUserAppStatus } from "../stores/appStatus";
import {
  formatControlStates,
  toggleBold,
  toggleBulletedList,
  toggleHeading1,
  toggleItalic,
  type FormatCommandResult,
  type FormatControlStates,
} from "./formatCommands";
import { displayShortcut, KEYMAP } from "./keymap";
import { setSourceView, viewModeField } from "./viewMode";
import { ToolbarOverflowContext, ToolbarOverflowSlot } from "./ToolbarOverflowSlot";
import { TimelineHostAction } from "../timeline/TimelineHostAction";
import { SharedDictationMic } from "../voice/SharedDictationMic";
import type { VoiceDictationEvent } from "../settings/voiceIpc";

export interface TimelineReturnControl {
  pending: boolean;
  onActivate: (origin: HTMLElement | null, input: "pointer" | "keyboard") => void;
}

export interface ViewModeToolbarProps {
  /** The mounted editor view; renders nothing until it loads. */
  view: EditorView | null;
  /**
   * Bumped by the editor on every view update, so this re-reads the live view-mode state. A
   * decoration-only transaction (a source-view/display-mode switch) moves neither `doc` nor
   * `selection`, so `EditorShell` must bump this on the view-mode effects specifically — it can't
   * rely on the `docChanged`/`selectionSet` check `RedlineReview` uses for the same prop.
   */
  version: number;
  platform?: "win" | "mac";
  contextControls?: ReactNode;
  batchAddressControl?: ReactNode;
  timelineReturn?: TimelineReturnControl;
  onDictationEvent?: (event: VoiceDictationEvent) => void;
  onDictationStart?: () => void;
  onDictationRetire?: () => void;
}

type FormatControlName = keyof FormatControlStates;

const FORMAT_CONTROLS: readonly {
  name: FormatControlName;
  label: "Bold" | "Italic" | "Heading 1" | "Bulleted list";
  glyph: "B" | "I" | "H1" | "≔";
  size: "inline" | "block";
  shortcut?: string;
  run: (view: EditorView) => FormatCommandResult;
}[] = [
  {
    name: "bold",
    label: "Bold",
    glyph: "B",
    size: "inline",
    shortcut: KEYMAP.bold.spec,
    run: toggleBold,
  },
  {
    name: "italic",
    label: "Italic",
    glyph: "I",
    size: "inline",
    shortcut: KEYMAP.italic.spec,
    run: toggleItalic,
  },
  { name: "heading1", label: "Heading 1", glyph: "H1", size: "block", run: toggleHeading1 },
  {
    name: "bulletedList",
    label: "Bulleted list",
    glyph: "≔",
    size: "block",
    run: toggleBulletedList,
  },
];

const FORMAT_GROUP_ID = "format-group";
const EDITOR_VIEW_ID = "editor-view";
const REVIEW_IDS = ["review-accept", "review-reject", "review-stepper", "review-bulk"];
const BATCH_ADDRESS_ID = "comment-address-all";
// The Timeline return stays inline across permission changes; the popover keeps moved controls in row order.
const COLLAPSE_ORDER = [
  BATCH_ADDRESS_ID,
  "review-bulk", "review-stepper", "review-reject", "review-accept",
  FORMAT_GROUP_ID,
  EDITOR_VIEW_ID,
];
const TOOLBAR_GAP = 10;
type RestoreFocus = { id: string; focusIndex: number } | { id: null };

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function focusInSlot(slot: HTMLElement, index: number): boolean {
  const focusables = slot.querySelectorAll<HTMLElement>("button, summary");
  const matching = focusables[index];
  const target = matching?.getClientRects().length ? matching : focusables[0];
  if (!target) return false;
  target.focus();
  return document.activeElement === target;
}

export function ViewModeToolbar({
  view,
  version,
  platform,
  contextControls,
  batchAddressControl,
  timelineReturn,
  onDictationEvent,
  onDictationStart,
  onDictationRetire,
}: ViewModeToolbarProps) {
  void version;
  const loadingDescriptionId = useId();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const editorViewRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inlineElements = useRef(new Map<string, HTMLElement>());
  const measuredWidths = useRef(new Map<string, number>());
  const focusTriggerAfterCollapse = useRef(false);
  const focusAfterExpansion = useRef<RestoreFocus | null>(null);
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [menuHost, setMenuHost] = useState<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 0 });
  const hasReview = contextControls !== null && contextControls !== undefined;
  const hasBatchAddress = batchAddressControl !== null && batchAddressControl !== undefined;
  const hasTimelineReturn = timelineReturn !== undefined;
  const actionIds = useMemo(
    () => [EDITOR_VIEW_ID, FORMAT_GROUP_ID, ...(hasReview ? REVIEW_IDS : []), ...(hasBatchAddress ? [BATCH_ADDRESS_ID] : []), ...(hasTimelineReturn ? ["timeline"] : [])],
    [hasReview, hasBatchAddress, hasTimelineReturn],
  );
  const hidden = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  const registerInline = useCallback((id: string, element: HTMLElement | null) => {
    if (!element) {
      inlineElements.current.delete(id);
      return;
    }
    inlineElements.current.set(id, element);
    const restore = focusAfterExpansion.current;
    if (restore?.id === id && focusInSlot(element, restore.focusIndex)) {
      focusAfterExpansion.current = null;
    }
  }, []);
  const focusOverflowTrigger = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return false;
    trigger.focus();
    return document.activeElement === trigger;
  }, []);
  const overflowContext = useMemo(
    () => ({ hidden, menuHost, registerInline, focusOverflowTrigger,
      getOverflowTrigger: () => triggerRef.current, setChooserOpen }),
    [hidden, menuHost, registerInline, focusOverflowTrigger],
  );

  const measure = useCallback(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || toolbar.clientWidth <= 0) return;
    for (const [id, element] of inlineElements.current) {
      if (element.offsetWidth > 0) measuredWidths.current.set(id, element.offsetWidth);
    }
    if (actionIds.some((id) => !measuredWidths.current.get(id))) return;
    const style = getComputedStyle(toolbar);
    const available = toolbar.clientWidth -
      (Number.parseFloat(style.paddingLeft) || 0) -
      (Number.parseFloat(style.paddingRight) || 0);
    const required = (removed: ReadonlySet<string>) => {
      const groupWidth = (ids: readonly string[], gap: number) => {
        const present = ids.filter((id) => actionIds.includes(id) && !removed.has(id));
        if (present.length === 0) return 0;
        return 11 + present.reduce((width, id) => width + measuredWidths.current.get(id)!, 0) +
          (present.length - 1) * gap;
      };
      const formatWidth = removed.has(FORMAT_GROUP_ID)
        ? 0 : measuredWidths.current.get(FORMAT_GROUP_ID)!;
      const timelineWidth = actionIds.includes("timeline") && !removed.has("timeline")
        ? measuredWidths.current.get("timeline")! : 0;
      const editorViewWidth = removed.has(EDITOR_VIEW_ID)
        ? 0 : measuredWidths.current.get(EDITOR_VIEW_ID)!;
      const groups = [editorViewWidth, formatWidth, groupWidth([...REVIEW_IDS, BATCH_ADDRESS_ID], 6), 28, timelineWidth]
        .filter((width) => width > 0);
      if (removed.size > 0) groups.push(28);
      return groups.reduce((total, width) => total + width, 0) +
        (groups.length - 1) * TOOLBAR_GAP;
    };
    const removed = new Set<string>();
    if (required(removed) > available) {
      for (const id of COLLAPSE_ORDER) {
        if (!actionIds.includes(id)) continue;
        removed.add(id);
        if (required(removed) <= available) break;
      }
    }
    const next = actionIds.filter((id) => removed.has(id));
    if (!sameIds(hiddenIds, next)) {
      const active = document.activeElement;
      if (next.some((id) => inlineElements.current.get(id)?.contains(active))) {
        focusTriggerAfterCollapse.current = true;
      } else if (active === triggerRef.current && next.length === 0) {
        focusAfterExpansion.current = { id: null };
      } else if (active && menuHost?.contains(active)) {
        const slot = active.closest<HTMLElement>("[data-toolbar-control]");
        const id = slot?.dataset.toolbarControl;
        if (id && !next.includes(id)) {
          const focusables = Array.from(slot.querySelectorAll<HTMLElement>("button, summary"));
          focusAfterExpansion.current = {
            id,
            focusIndex: Math.max(0, focusables.indexOf(active as HTMLElement)),
          };
        }
      }
    }
    setHiddenIds((prior) => sameIds(prior, next) ? prior : next);
  }, [actionIds, hiddenIds, menuHost]);

  useLayoutEffect(() => { measure(); });
  useLayoutEffect(() => {
    if (!focusTriggerAfterCollapse.current || !triggerRef.current) return;
    focusTriggerAfterCollapse.current = false;
    triggerRef.current.focus();
  }, [hiddenIds]);
  useLayoutEffect(() => {
    const restore = focusAfterExpansion.current;
    if (!restore) return;
    if (restore.id && actionIds.includes(restore.id)) {
      // The returning portal slot can register after this parent layout effect.
      const slot = inlineElements.current.get(restore.id);
      if (!slot || !focusInSlot(slot, restore.focusIndex)) return;
      focusAfterExpansion.current = null;
      return;
    }
    focusAfterExpansion.current = null;
    const fallback = editorViewRef.current?.querySelector<HTMLElement>(
      'button[aria-pressed="true"]',
    ) ?? editorViewRef.current?.querySelector<HTMLElement>("button");
    fallback?.focus();
  }, [actionIds, hiddenIds]);
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(toolbar);
    if (editorViewRef.current) observer.observe(editorViewRef.current);
    for (const element of inlineElements.current.values()) observer.observe(element);
    return () => observer.disconnect();
  }, [measure, hiddenIds]);

  useEffect(() => {
    if (hiddenIds.length === 0) setOverflowOpen(false);
  }, [hiddenIds.length]);
  useEffect(() => {
    if (!overflowOpen) return;
    const onOutside = (event: globalThis.MouseEvent) => {
      if (toolbarRef.current?.contains(event.target as Node)) return;
      if (event.target instanceof Element && event.target.closest(".batch-address__panel--floating")) return;
      setOverflowOpen(false);
      requestAnimationFrame(() => {
        if (menuHost?.contains(document.activeElement)) triggerRef.current?.focus();
      });
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOverflowOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [overflowOpen, menuHost]);
  useEffect(() => {
    if (!menuHost) return;
    // Portal children follow their React parent for synthetic events, not this DOM host. A native
    // listener closes the popover after a moved button runs, including keyboard activation.
    const onMovedButtonClick = (event: globalThis.MouseEvent) => {
      if (!(event.target as HTMLElement).closest("button")) return;
      setOverflowOpen(false);
      requestAnimationFrame(() => {
        if (document.activeElement === document.body || menuHost.contains(document.activeElement)) {
          triggerRef.current?.focus();
        }
      });
    };
    menuHost.addEventListener("click", onMovedButtonClick);
    return () => menuHost.removeEventListener("click", onMovedButtonClick);
  }, [menuHost]);
  const placeMenu = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = { top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) };
    setMenuPosition((prior) => prior.top === next.top && prior.right === next.right ? prior : next);
  }, []);
  useLayoutEffect(() => {
    if (!overflowOpen) return;
    placeMenu();
  }, [overflowOpen, hiddenIds, placeMenu]);
  useLayoutEffect(() => {
    if (!overflowOpen) return;
    menuHost?.querySelector<HTMLElement>("button, summary")?.focus();
  }, [overflowOpen, menuHost]);
  useEffect(() => {
    if (!overflowOpen) return;
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  }, [overflowOpen, placeMenu]);

  if (!view) return null;
  const { sourceView } = view.state.field(viewModeField);
  const controlStates = formatControlStates(view.state);
  const readOnly = view.state.readOnly;

  const activate = (
    event: MouseEvent<HTMLButtonElement>,
    state: FormatControlStates[FormatControlName],
    run: (currentView: EditorView) => FormatCommandResult,
  ) => {
    if (state === "pending" || readOnly) {
      if (state === "pending" && event.detail > 0) view.focus();
      return;
    }
    beginAppStatusRequest();
    const result = run(view);
    if (result.status === "unavailable") setUserAppStatus(result.reason);
    // Native button clicks synthesized by Enter/Space have detail 0. A pointer click moves focus
    // into the toolbar first, so restore the editor only for that input origin (J14/UXR-Q21).
    if (event.detail > 0) view.focus();
  };

  return (
    <ToolbarOverflowContext.Provider value={overflowContext}>
      <div
      ref={toolbarRef}
      className="view-mode-toolbar"
      role="toolbar"
      aria-label="Editor view controls"
      data-platform={platform}
    >
      <ToolbarOverflowSlot id={EDITOR_VIEW_ID}>
      <div
        ref={editorViewRef}
        className="view-mode-toolbar__editor-view"
        role="group"
        aria-label="Editor view"
      >
        <button
          type="button"
          className="view-mode-toolbar__editor-view-option"
          aria-pressed={!sourceView}
          onClick={() => view.dispatch({ effects: setSourceView.of(false) })}
        >
          Rich text
        </button>
        <button
          type="button"
          className="view-mode-toolbar__editor-view-option"
          aria-pressed={sourceView}
          onClick={() => view.dispatch({ effects: setSourceView.of(true) })}
        >
          Markdown
        </button>
      </div>
      </ToolbarOverflowSlot>
      <ToolbarOverflowSlot id={FORMAT_GROUP_ID}>
        <div className="view-mode-toolbar__format" role="group" aria-label="Formatting">
          {FORMAT_CONTROLS.map(({ name, label, glyph, size, shortcut, run }) => {
            const state = controlStates[name];
            const pending = state === "pending";
            return (
              <button
                key={name}
                type="button"
                className={`view-mode-toolbar__format-option view-mode-toolbar__format-option--${size}`}
                aria-label={label}
                title={
                  shortcut
                    ? `${label} (${displayShortcut(shortcut, platform ? platform === "mac" : undefined)})`
                    : label
                }
                aria-pressed={pending ? undefined : state === "active"}
                aria-disabled={pending ? "true" : undefined}
                aria-busy={pending ? "true" : undefined}
                aria-describedby={pending ? loadingDescriptionId : undefined}
                disabled={readOnly}
                onClick={(event) => activate(event, state, run)}
              >
                {glyph}
              </button>
            );
          })}
          <span id={loadingDescriptionId} className="sr-only">
            Formatting state is still loading.
          </span>
        </div>
      </ToolbarOverflowSlot>
      {contextControls}
      {batchAddressControl && <ToolbarOverflowSlot id={BATCH_ADDRESS_ID}>{batchAddressControl}</ToolbarOverflowSlot>}
      <span className="view-mode-toolbar__dictation"><SharedDictationMic platform={platform} disabledForReadOnly={readOnly}
        onDictationEvent={onDictationEvent} onDictationStart={onDictationStart} onDictationRetire={onDictationRetire} /></span>
      {timelineReturn && (
        <ToolbarOverflowSlot id="timeline">
          <TimelineHostAction
            mode="collapsed"
            pending={timelineReturn.pending}
            onActivate={timelineReturn.onActivate}
          />
        </ToolbarOverflowSlot>
      )}
      {hiddenIds.length > 0 && (
        <button
          ref={triggerRef}
          type="button"
          className="view-mode-toolbar__overflow-trigger"
          data-chooser-open={chooserOpen || undefined}
          aria-label="More editor controls"
          aria-haspopup="dialog"
          aria-expanded={overflowOpen}
          onClick={() => setOverflowOpen((open) => !open)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOverflowOpen(true);
            }
          }}
        >
          <Ellipsis aria-hidden="true" size={16} strokeWidth={1.75} />
        </button>
      )}
      <div
        ref={setMenuHost}
        className="view-mode-toolbar__overflow-popover redline-toolbar redline-toolbar--embedded"
        role="dialog"
        aria-label="More editor controls"
        aria-hidden={!overflowOpen}
        inert={!overflowOpen}
        style={menuPosition}
      />
    </div>
    </ToolbarOverflowContext.Provider>
  );
}
