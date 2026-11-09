// ABOUTME: Vitest setup for component tests — unmounts React Testing Library renders after each
// ABOUTME: test (otherwise DOM piles up across tests sharing one jsdom `document`) and extends
// ABOUTME: `expect` with the jest-dom matchers (`toBeDisabled`, etc.) component tests use.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// CM6 measures text through Range#getClientRects on a requestAnimationFrame after selection
// changes that request scrolling. jsdom has no layout engine and omits that method, so the frame
// can otherwise throw after an EditorShell assertion has already completed. Returning no layout
// rectangles matches jsdom's zero-layout model and keeps the real CM6 scheduling path exercised.
if (typeof Range !== "undefined" && !Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [],
  });
}

afterEach(() => {
  cleanup();
});
