// ABOUTME: Shared "close a transient pick-one overlay" behavior (P2b-2a, #415) — outside-click and
// ABOUTME: Escape dismissal for a native `<details>`-based menu, which implements neither on its own.
import { useEffect, type RefObject } from "react";

/**
 * While `open`, closes the menu (via `setOpen(false)`) on a `mousedown` outside `containerRef`'s
 * element or on Escape anywhere in the document — the two dismissals a native `<details>` element
 * doesn't give you for free, so an absolutely-positioned options panel would otherwise keep
 * overlaying the document until its `<summary>` is clicked again.
 *
 * Extracted from `editor/TrackChangesBulkMenu.tsx` and `timeline/ChangeSetCard.tsx`'s overflow
 * menu, which had carried byte-identical copies of this effect since they landed in the same PR
 * (#393) — CLAUDE.md's Rule of Three doesn't strictly require three occurrences before collapsing
 * *literal* duplication already in the codebase (the #410 `mergeDecidedIds` precedent), and a third
 * caller was already named as wanting the same thing (`docs/journal.md`, #350 review addendum,
 * `RedlinePopover`) before this landed. `RedlinePopover` itself is deliberately not migrated here:
 * its outside-click dismissal is routed through CodeMirror's own click handling (a click anywhere in
 * the editor content, not just outside the popover DOM, can already reassign or close it), which is
 * a materially different mechanism from a raw `document`-level listener — folding it into this
 * `document`-level hook risks a same-tick ordering race between the two dismissal paths (the CM6
 * click bridge re-opening a different change's popover, then this hook's own listener immediately
 * closing it again as "outside"). That unification is real follow-on work, not a safe rename.
 *
 * Listeners are bound only while `open` and torn down with it, matching the two call sites'
 * pre-extraction behavior exactly (no behavior change, confirmed by their existing dismissal tests
 * continuing to pass unmodified).
 */
export function useDismissOnOutsideOrEscape(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  setOpen: (open: boolean) => void,
): void {
  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, containerRef, setOpen]);
}
