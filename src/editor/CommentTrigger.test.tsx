// @vitest-environment jsdom
// ABOUTME: Component proof of the #259 comment affordance: renders, positions from the caller's
// ABOUTME: style, and fires onComment — never touching the CM6 view itself (Principle 2). Mirrors
// ABOUTME: `QuoteAffordance.test.tsx`'s identical shape for its sibling affordance.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommentTrigger } from "./CommentTrigger";

describe("editor/CommentTrigger", () => {
  it("renders a button inviting the user to comment on the selection", () => {
    render(<CommentTrigger onComment={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Comment" })).toBeTruthy();
  });

  it("fires onComment on click", () => {
    const onComment = vi.fn();
    render(<CommentTrigger onComment={onComment} />);

    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(onComment).toHaveBeenCalledTimes(1);
  });

  it("applies the caller-supplied position style verbatim", () => {
    render(<CommentTrigger onComment={vi.fn()} style={{ position: "absolute", top: 10, left: 20 }} />);
    const button = screen.getByRole("button", { name: "Comment" });
    expect(button.style.top).toBe("10px");
    expect(button.style.left).toBe("20px");
  });

  it("renders unpositioned when no style is given (no layout available yet)", () => {
    render(<CommentTrigger onComment={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Comment" });
    expect(button.getAttribute("style")).toBeNull();
  });
});
