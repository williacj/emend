// @vitest-environment jsdom
// ABOUTME: Component-level proof of the P2a-18 "Create" acceptance: selecting text (or not) opens
// ABOUTME: a composer that submits an anchored or document-level comment (FR-CMT-1).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommentComposer } from "./CommentComposer";

describe("comments/CommentComposer", () => {
  it("shows the selected text preview when a selection is given (anchored comment)", () => {
    render(
      <CommentComposer selection={{ offset: 6, length: 5, preview: "world" }} onSubmit={vi.fn()} />,
    );
    expect(screen.getByText("Commenting on: “world”")).toBeTruthy();
  });

  it("shows a document-level label when there is no selection", () => {
    render(<CommentComposer selection={null} onSubmit={vi.fn()} />);
    expect(screen.getByText("Document-level comment")).toBeTruthy();
  });

  it("submits the trimmed body and clears the field", () => {
    const onSubmit = vi.fn();
    render(<CommentComposer selection={null} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "  please clarify  " } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmit).toHaveBeenCalledWith("please clarify");
    expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("");
  });

  it("does not submit blank/whitespace-only input", () => {
    const onSubmit = vi.fn();
    render(<CommentComposer selection={null} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("enables the primary Comment action only for a nonempty draft", () => {
    const onSubmit = vi.fn();
    render(<CommentComposer selection={null} onSubmit={onSubmit} onCancel={vi.fn()} />);
    const comment = screen.getByRole("button", { name: "Comment" });
    expect(comment).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "   " } });
    expect(comment).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "A clear note" } });
    expect(comment).toBeEnabled();
    fireEvent.click(comment);
    expect(onSubmit).toHaveBeenCalledWith("A clear note");
    expect(comment).toBeDisabled();
  });

  it("calls onCancel and shows no Cancel button when it's omitted", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <CommentComposer selection={null} onSubmit={vi.fn()} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    rerender(<CommentComposer selection={null} onSubmit={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});
