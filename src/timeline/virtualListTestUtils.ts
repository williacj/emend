// ABOUTME: Shared jsdom test helper for `timeline/`'s `VirtualList`-backed component tests
// ABOUTME: (TimelinePanel.test.tsx, TimelinePanel.facets.test.tsx, VirtualList.test.tsx) — not a test file itself.
import { fireEvent } from "@testing-library/react";

/** Overrides the list container's `clientHeight` without touching its scroll position. `VirtualList`
 * re-measures on every commit, so a caller applies this and then triggers any rerender to let the
 * measurement land — the route to use when the scroll position itself is under test, since
 * `sizeContainer` below drives the measurement *via* scroll events and so necessarily ends by
 * imposing one. */
export function setContainerHeight(container: HTMLElement, height: number): HTMLElement {
  const el = container.querySelector('[data-testid="virtual-list"]');
  if (!el) throw new Error("virtual-list container not found");
  Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
  return el as HTMLElement;
}

/** jsdom never runs layout, so `clientHeight`/`scrollTop` are inert plain properties by default.
 * Overriding `clientHeight` and then firing a `scroll` event (which drives a state update and thus
 * a re-render) is enough to exercise the real measurement path in `VirtualList` — but only if the
 * fired `scrollTop` actually differs from the component's current state (still 0 right after
 * mount): React bails out of re-rendering on a same-value `setState`, so a `scrollTop: 0` fire right
 * after mount is a no-op that never lets the (now-overridden) `clientHeight` get re-read, and
 * `containerHeight` state silently stays 0. Scroll to a throwaway nonzero position first to force a
 * genuine state change (and the containerHeight measurement that rides along with it), then back to
 * 0 so callers see the container at rest (review finding, PR #392 — this is what let the original
 * facet-jump clamp bug hide behind a green suite). */
export function sizeContainer(container: HTMLElement, height: number): HTMLElement {
  const el = container.querySelector('[data-testid="virtual-list"]');
  if (!el) throw new Error("virtual-list container not found");
  Object.defineProperty(el, "clientHeight", { value: height, configurable: true });
  fireEvent.scroll(el, { target: { scrollTop: 1 } });
  fireEvent.scroll(el, { target: { scrollTop: 0 } });
  return el as HTMLElement;
}

/**
 * jsdom runs no layout, so every `getBoundingClientRect()` answers zero — a mounted row can never
 * report a real rendered height on its own, which is exactly the measurement `VirtualList` now
 * positions rows by (#1119). Patches the prototype to answer `heights[rowKey]` for any element
 * carrying `data-row-key` (the attribute `VirtualList` stamps on each mounted row), leaving every
 * other element on jsdom's zero-layout default. `heights` is read on every call, so a test can
 * mutate it in place to simulate a row growing and then let the new reading land. Call before
 * `render`, and call the returned restore function once done.
 */
export function mockRowHeights(heights: Record<string, number>): () => void {
  const original = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    const key = this.getAttribute("data-row-key");
    const height = key === null ? undefined : heights[key];
    if (height === undefined) return original.call(this);
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: height,
      width: 0,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original;
  };
}

/** jsdom implements no `ResizeObserver`, so the path `VirtualList` uses to notice a row changing
 * height with no re-render of the list at all (a container width change rewrapping text, a font
 * finishing loading) is otherwise unreachable from a test. Installs a stub that records every
 * observed element and exposes `trigger()` to deliver a notification for them, as the real observer
 * would after layout. */
export function installResizeObserverStub(): { trigger: () => void; restore: () => void } {
  const globals = globalThis as { ResizeObserver?: unknown };
  const original = Object.getOwnPropertyDescriptor(globals, "ResizeObserver");
  const callbacks: Array<() => void> = [];

  class ResizeObserverStub {
    constructor(private readonly callback: () => void) {}
    observe() {
      callbacks.push(this.callback);
    }
    unobserve() {}
    disconnect() {
      const index = callbacks.indexOf(this.callback);
      if (index >= 0) callbacks.splice(index, 1);
    }
  }

  globals.ResizeObserver = ResizeObserverStub;
  return {
    trigger: () => {
      for (const callback of [...callbacks]) callback();
    },
    restore: () => {
      if (original) Object.defineProperty(globals, "ResizeObserver", original);
      else delete globals.ResizeObserver;
    },
  };
}

let mockedClientHeight: number | undefined;

/** Patches `HTMLElement.prototype.clientHeight` so it reads `height` from the very first commit —
 * a real browser has layout before `VirtualList`'s first `useLayoutEffect` runs, but every other
 * helper here (`setContainerHeight`, `sizeContainer`) only overrides the property on the container
 * element *after* `render()` has already returned, i.e. after that first commit already measured 0.
 * Call before `render`, and call the returned restore function once done (review finding, PR #504 —
 * the untested browser-shaped mount ordering that let the `atTailRef` mount-measurement bug hide
 * behind a green suite). Global for the duration of the test, not scoped to one element, since the
 * container doesn't exist to `defineProperty` on until after `render()` runs. */
export function mockClientHeight(height: number): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  mockedClientHeight = height;
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return mockedClientHeight ?? 0;
    },
  });
  return () => {
    mockedClientHeight = undefined;
    // jsdom defines `clientHeight` on `Element.prototype`, not `HTMLElement.prototype`, so `original`
    // is normally `undefined` and the patched getter has to be deleted rather than overwritten —
    // otherwise it outlives the test on the shared prototype for the rest of the worker.
    if (original) Object.defineProperty(HTMLElement.prototype, "clientHeight", original);
    else delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight;
  };
}
