// @vitest-environment jsdom
// ABOUTME: The composer's quote state (P2b-7): a newly attached quote shows above the input,
// ABOUTME: dismisses without sending, travels with the next sent message, and clears after send.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MessageComposer } from "./MessageComposer";
import type { QuotedExcerpt } from "./types";

const QUOTE: QuotedExcerpt = {
  documentPath: "notes/outline.md",
  text: "the quoted sentence",
  anchor: {
    offset: 10,
    length: 20,
    text_snapshot: "the quoted sentence",
    context_before: "before ",
    context_after: " after",
    base_revision: "blake3:abc",
  },
};

function otherQuote(text: string): QuotedExcerpt {
  return { ...QUOTE, text, anchor: { ...QUOTE.anchor, text_snapshot: text } };
}

/** The quote bar's own text (excluding the "×" dismiss button also inside the labelled region). */
function quoteBarText(): string | null | undefined {
  return screen.getByLabelText("Quoted selection").querySelector(".quote-bar__text")?.textContent;
}

describe("timeline/MessageComposer — quote state", () => {
  it("shows no quote bar when no quote is incoming", () => {
    render(<MessageComposer onSubmit={vi.fn()} />);
    expect(screen.queryByLabelText("Quoted selection")).toBeNull();
  });

  it("shows the quote bar with the quoted text once a quote is attached", () => {
    render(<MessageComposer incomingQuote={QUOTE} onSubmit={vi.fn()} />);
    expect(quoteBarText()).toBe("“the quoted sentence”");
  });

  it("dismissing the quote bar removes it without sending anything", () => {
    const onSubmit = vi.fn();
    render(<MessageComposer incomingQuote={QUOTE} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove quote" }));

    expect(screen.queryByLabelText("Quoted selection")).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("sending includes the attached quote and then clears the quote bar", () => {
    const onSubmit = vi.fn();
    render(<MessageComposer incomingQuote={QUOTE} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "see this" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledWith("see this", QUOTE);
    expect(screen.queryByLabelText("Quoted selection")).toBeNull();
  });

  it("sending with no quote attached passes null, not undefined or an empty object", () => {
    const onSubmit = vi.fn();
    render(<MessageComposer onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "plain message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSubmit).toHaveBeenCalledWith("plain message", null);
  });

  it("a dismissed quote does not silently resurface on the next unrelated render", () => {
    const { rerender } = render(<MessageComposer incomingQuote={QUOTE} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove quote" }));
    expect(screen.queryByLabelText("Quoted selection")).toBeNull();

    // The owner passes the exact same quote object again (it hasn't seen a new selection) — the
    // dismiss must stick, not reattach from a stable prop the owner never changed.
    rerender(<MessageComposer incomingQuote={QUOTE} onSubmit={vi.fn()} />);

    expect(screen.queryByLabelText("Quoted selection")).toBeNull();
  });

  it("a genuinely new incoming quote (a fresh selection) attaches even after a prior dismiss", () => {
    const { rerender } = render(<MessageComposer incomingQuote={QUOTE} onSubmit={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove quote" }));

    const second = otherQuote("a second selection");
    rerender(<MessageComposer incomingQuote={second} onSubmit={vi.fn()} />);

    expect(quoteBarText()).toBe("“a second selection”");
  });

  it("a later distinct incoming quote replaces one already attached and unsent", () => {
    const { rerender } = render(<MessageComposer incomingQuote={QUOTE} onSubmit={vi.fn()} />);
    expect(quoteBarText()).toBe("“the quoted sentence”");

    const second = otherQuote("a second selection");
    rerender(<MessageComposer incomingQuote={second} onSubmit={vi.fn()} />);

    expect(quoteBarText()).toBe("“a second selection”");
  });
});
