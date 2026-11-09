// ABOUTME: Shared [Address all… ▾] batch trigger for the editor toolbar and standalone Timeline (P2b-3a, FR-CMT-5/D8) —
// ABOUTME: counts filtered open comments and discloses the live/queued-held subset before an optional exact-ID inclusion.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  HUMAN_SOURCE,
  NO_BATCH_FILTER,
  canBatchAddress,
  reviewPassesIn,
  selectBatchSelection,
  sourcesIn,
  type BatchAddressFilter,
} from "./batchAddress";
import type { CommentThread } from "./types";
import { useToolbarOverflow } from "../editor/ToolbarOverflowSlot";

/** J4's "severity ≥" options, in the long spelling `batchAddress.severityRank` normalizes. */
const SEVERITY_FLOORS = ["low", "medium", "high"];

interface BatchAddressTriggerBaseProps {
  /** The document's current threads; the trigger derives its own open set from these. */
  threads: CommentThread[];
  /** Starts a batch run against the filtered target ids. Spawning the provider run itself rides
   * the agent-run seam — this component only names the targets. */
  onAddressAll: (threadIds: string[], includeHeldThreadIds: string[]) => void;
  liveRunIds?: readonly string[];
  terminalRunIds?: readonly string[];
  /** Whether an atomic batch admission is still pending; refuse a duplicate click until it settles. */
  running?: boolean;
  /** The editor toolbar clips overflow to one row; its chooser floats outside that paint boundary. */
  floatingPanel?: boolean;
}

export type BatchAddressTriggerProps = BatchAddressTriggerBaseProps & (
  | { filter: BatchAddressFilter; onFilterChange: (filter: BatchAddressFilter) => void }
  | { filter?: never; onFilterChange?: never }
) & (
  | { includedHeldKey: string | null; onIncludedHeldKeyChange: (key: string | null) => void }
  | { includedHeldKey?: never; onIncludedHeldKeyChange?: never }
);

/**
 * One filter dimension: a labelled `<select>` whose empty option is the unfiltered choice, mapped
 * to `null` on the filter. All three dimensions share this shape, so the panel below stays a list
 * of dimensions rather than three near-identical blocks.
 */
function FilterSelect({
  label,
  value,
  options,
  optionLabel = (option: string) => option,
  onChange,
}: {
  label: string;
  value: string | null;
  options: string[];
  optionLabel?: (option: string) => string;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="batch-address__filter">
      <span>{label}</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}>
        <option value="">All</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {optionLabel(option)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * `[Address all… ▾]` — J4's batch entry point in the editor toolbar or a standalone Timeline.
 * It renders only when more than one comment is open; one open comment is the single-address path's
 * job. No source, severity, or pass filter is pre-applied; the default set excludes only threads
 * already held by a live or queued run (J4-Q1). The three FR-CMT-5 dimensions are source, severity,
 * review pass — and each dropdown lists current values. A selected value stays visible even if its
 * last matching thread closes while the sheet is open, so a zero-target result is never mislabeled All.
 */
export function BatchAddressTrigger({ threads, onAddressAll, liveRunIds, terminalRunIds, running = false, floatingPanel = false,
  filter: controlledFilter, onFilterChange, includedHeldKey: controlledIncludedHeldKey,
  onIncludedHeldKeyChange }: BatchAddressTriggerProps) {
  const [open, setOpen] = useState(false);
  const [localFilter, setLocalFilter] = useState<BatchAddressFilter>(NO_BATCH_FILTER);
  const filter = controlledFilter ?? localFilter;
  const [localIncludedHeldKey, setLocalIncludedHeldKey] = useState<string | null>(null);
  const includedHeldKey = controlledIncludedHeldKey === undefined ? localIncludedHeldKey : controlledIncludedHeldKey;
  const setIncludedHeldKey = onIncludedHeldKeyChange ?? setLocalIncludedHeldKey;
  const scopeId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusedOpenRef = useRef(false);
  const [panelPosition, setPanelPosition] = useState<{ top: number; left: number; platform?: string } | null>(null);
  const toolbarOverflow = useToolbarOverflow();
  const movedToOverflow = floatingPanel && toolbarOverflow?.hidden.has("comment-address-all");

  useEffect(() => {
    if (!movedToOverflow) return;
    toolbarOverflow?.setChooserOpen?.(open);
    return () => toolbarOverflow?.setChooserOpen?.(false);
  }, [movedToOverflow, open, toolbarOverflow?.setChooserOpen]);

  const focusInvoker = () => {
    const trigger = triggerRef.current;
    if (trigger?.closest('[inert], [aria-hidden="true"]')) {
      if (toolbarOverflow?.focusOverflowTrigger()) return;
    }
    trigger?.focus();
  };

  useLayoutEffect(() => {
    if (!open || !floatingPanel) return;
    const place = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const anchor = movedToOverflow ? toolbarOverflow?.getOverflowTrigger?.() ?? trigger : trigger;
      const origin = anchor.getBoundingClientRect();
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      const below = origin.bottom + 4;
      setPanelPosition({
        left: Math.max(8, Math.min(origin.right - width, window.innerWidth - width - 8)),
        top: below + height <= window.innerHeight - 8 ? below : Math.max(8, origin.top - height - 4),
        platform: trigger.closest<HTMLElement>("[data-platform]")?.dataset.platform,
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, floatingPanel, filter, threads, liveRunIds, terminalRunIds, includedHeldKey,
    movedToOverflow, toolbarOverflow?.getOverflowTrigger]);

  useLayoutEffect(() => {
    if (!open) {
      focusedOpenRef.current = false;
      return;
    }
    if (focusedOpenRef.current || (floatingPanel && !panelPosition)) return;
    const firstFilter = panelRef.current?.querySelector("select");
    if (!firstFilter) return;
    firstFilter.focus();
    focusedOpenRef.current = true;
  }, [open, floatingPanel, panelPosition]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (triggerRef.current?.contains(event.target as Node) || panelRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      focusInvoker();
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, [open]);

  const selection = selectBatchSelection(threads, filter, liveRunIds, terminalRunIds);
  const heldIds = selection.held.map((thread) => thread.id);
  const heldKey = JSON.stringify(heldIds);
  const includeHeld = heldIds.length > 0 && includedHeldKey === heldKey;
  const targets = includeHeld ? selection.matching : selection.available;
  const noun = targets.length === 1 ? "comment" : "comments";
  const sourceOptions = sourcesIn(threads);
  if (filter.source !== null && !sourceOptions.includes(filter.source)) sourceOptions.push(filter.source);
  const reviewPassOptions = reviewPassesIn(threads);
  if (filter.reviewPass !== null && !reviewPassOptions.includes(filter.reviewPass)) reviewPassOptions.push(filter.reviewPass);

  // A new held ID must require a fresh deliberate opt-in, even if the sheet stays open while a
  // run is admitted. The key also changes when filtering removes a held ID.
  useEffect(() => {
    if (includedHeldKey !== null && includedHeldKey !== heldKey) setIncludedHeldKey(null);
  }, [heldKey, includedHeldKey]);

  if (!canBatchAddress(threads)) return null;

  const set = (patch: Partial<BatchAddressFilter>) => {
    const next = { ...filter, ...patch };
    if (onFilterChange) onFilterChange(next);
    else setLocalFilter(next);
  };
  const panel = open && (
    <div ref={panelRef} role="dialog" aria-label="Address comments" className={`batch-address__panel${floatingPanel ? " batch-address__panel--floating" : ""}`}
      data-platform={panelPosition?.platform}
      style={floatingPanel ? panelPosition ? { top: panelPosition.top, left: panelPosition.left } : { visibility: "hidden" } : undefined}>
      <FilterSelect
        label="Source"
        value={filter.source}
        options={sourceOptions}
        optionLabel={(source) => (source === HUMAN_SOURCE ? "Human comments" : source)}
        onChange={(source) => set({ source })}
      />
      <FilterSelect
        label="Severity at least"
        value={filter.severityAtLeast}
        options={SEVERITY_FLOORS}
        onChange={(severityAtLeast) => set({ severityAtLeast })}
      />
      <FilterSelect
        label="Review pass"
        value={filter.reviewPass}
        options={reviewPassOptions}
        onChange={(reviewPass) => set({ reviewPass })}
      />
      <div className="batch-address__scope" aria-live="polite">
        <span id={scopeId}>Address all · {selection.matching.length} open {selection.matching.length === 1 ? "comment" : "comments"}{heldIds.length > 0 && ` · ${heldIds.length} already in an agent run —`}</span>
        {heldIds.length > 0 && (
          <label className="batch-address__include">
            <input type="checkbox" aria-describedby={scopeId} checked={includeHeld} onChange={(event) => setIncludedHeldKey(event.target.checked ? heldKey : null)} />
            include them too
          </label>
        )}
      </div>
      {/* Keep one atomic admission pending at a time; later runs have their own accounting. */}
      <button
        type="button"
        className="batch-address__run"
        disabled={targets.length === 0 || running}
        onClick={() => {
          setIncludedHeldKey(null);
          setOpen(false);
          focusInvoker();
          onAddressAll(targets.map((thread) => thread.id), includeHeld ? heldIds : []);
        }}
      >
        {running ? "Addressing…" : `Address ${targets.length} ${noun}`}
      </button>
    </div>
  );

  return (
    <div className="batch-address">
      <button
        ref={triggerRef}
        type="button"
        className="batch-address__trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      >
        Address all… ▾
      </button>

      {panel && (floatingPanel ? createPortal(panel, document.body) : panel)}
    </div>
  );
}
