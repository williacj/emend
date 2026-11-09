// @vitest-environment jsdom
// ABOUTME: Component proof of the P2b-7 quote affordance: renders, positions from the caller's
// ABOUTME: style, and fires onQuote — never touching the CM6 view itself (Principle 2).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuoteAffordance } from "./QuoteAffordance";

describe("editor/QuoteAffordance", () => {
  it("renders a button inviting the user to quote the selection", () => {
    render(<QuoteAffordance onQuote={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Quote to chat" })).toBeTruthy();
  });

  it("fires onQuote on click", () => {
    const onQuote = vi.fn();
    render(<QuoteAffordance onQuote={onQuote} />);

    fireEvent.click(screen.getByRole("button", { name: "Quote to chat" }));

    expect(onQuote).toHaveBeenCalledTimes(1);
  });

  it("applies the caller-supplied position style verbatim", () => {
    render(<QuoteAffordance onQuote={vi.fn()} style={{ position: "absolute", top: 10, left: 20 }} />);
    const button = screen.getByRole("button", { name: "Quote to chat" });
    expect(button.style.top).toBe("10px");
    expect(button.style.left).toBe("20px");
  });

  it("renders unpositioned when no style is given (no layout available yet)", () => {
    render(<QuoteAffordance onQuote={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Quote to chat" });
    expect(button.getAttribute("style")).toBeNull();
  });
});
