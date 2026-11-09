// @vitest-environment jsdom
// ABOUTME: Unit coverage for the #415 shared outside-click/Escape dismissal hook, pinned directly
// ABOUTME: against the hook rather than inferred only from its two call sites' own component tests.
import { useRef } from "react";
import { fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDismissOnOutsideOrEscape } from "./useDismissOnOutsideOrEscape";

/** Mounts the hook against a real `<div>` container appended to `document.body`, mirroring how a
 * `<details ref={containerRef}>` root sits in the two real call sites. */
function setup(open: boolean, setOpen: (open: boolean) => void) {
  const container = document.createElement("div");
  const inside = document.createElement("button");
  container.appendChild(inside);
  document.body.appendChild(container);

  renderHook(() => {
    const containerRef = useRef<HTMLElement | null>(container);
    useDismissOnOutsideOrEscape(open, containerRef, setOpen);
  });

  return { container, inside };
}

describe("useDismissOnOutsideOrEscape", () => {
  it("does nothing while closed — no listeners fire", () => {
    const setOpen = vi.fn();
    setup(false, setOpen);
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(setOpen).not.toHaveBeenCalled();
  });

  it("closes on a mousedown outside the container", () => {
    const setOpen = vi.fn();
    setup(true, setOpen);
    fireEvent.mouseDown(document.body);
    expect(setOpen).toHaveBeenCalledWith(false);
  });

  it("does not close on a mousedown inside the container", () => {
    const setOpen = vi.fn();
    const { inside } = setup(true, setOpen);
    fireEvent.mouseDown(inside);
    expect(setOpen).not.toHaveBeenCalled();
  });

  it("closes on Escape anywhere in the document", () => {
    const setOpen = vi.fn();
    setup(true, setOpen);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(setOpen).toHaveBeenCalledWith(false);
  });

  it("ignores a non-Escape key", () => {
    const setOpen = vi.fn();
    setup(true, setOpen);
    fireEvent.keyDown(document, { key: "Enter" });
    expect(setOpen).not.toHaveBeenCalled();
  });

  it("tears listeners down on unmount — no stray close after the component is gone", () => {
    const setOpen = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const containerRef = { current: container };
    const { unmount } = renderHook(() => useDismissOnOutsideOrEscape(true, containerRef, setOpen));
    unmount();
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(setOpen).not.toHaveBeenCalled();
  });
});
