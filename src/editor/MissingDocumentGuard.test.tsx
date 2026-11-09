// @vitest-environment jsdom
// ABOUTME: Tests for J2's two Missing-on-disk guarded choices (#933) — the manual Save that writes
// ABOUTME: nothing, and the close confirmation whose only destructive exit discards the buffer.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MissingDocumentGuard } from "./MissingDocumentGuard";

describe("editor/MissingDocumentGuard", () => {
  it("the save guard offers Cancel and Save As…, and Recreate only under proven confinement", () => {
    render(
      <MissingDocumentGuard
        kind="save"
        label="notes/outline.md"
        onCancel={vi.fn()}
        onSaveAs={vi.fn()}
        onRecreate={vi.fn()}
      />,
    );

    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(screen.getByText(/is missing from disk/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save As…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Recreate" })).toBeNull();
    // Nothing here can discard the buffer: a save that cannot write must not become a close.
    expect(screen.queryByRole("button", { name: "Close without saving" })).toBeNull();
    cleanup();

    render(
      <MissingDocumentGuard
        kind="save"
        label="notes/outline.md"
        recreatable
        onCancel={vi.fn()}
        onSaveAs={vi.fn()}
        onRecreate={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Recreate" })).toBeTruthy();
  });

  it("the close guard asks the recorded destructive question and offers the recorded three exits", () => {
    const onDiscard = vi.fn();
    render(
      <MissingDocumentGuard
        kind="close"
        label="notes/outline.md"
        recreatable
        onCancel={vi.fn()}
        onSaveAs={vi.fn()}
        onDiscard={onDiscard}
        onRecreate={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/no longer exists on disk\. Close and discard Cowrite’s open copy\?/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save As…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close without saving" })).toBeTruthy();
    // Recreate belongs to the save guard: this dialog is about the buffer, not about the path.
    expect(screen.queryByRole("button", { name: "Recreate" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Close without saving" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("names the document being decided about in both guards", () => {
    render(
      <MissingDocumentGuard
        kind="close"
        label="notes/outline.md"
        onCancel={vi.fn()}
        onSaveAs={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByRole("alertdialog", { name: "Close notes/outline.md?" })).toBeTruthy();
    cleanup();

    render(
      <MissingDocumentGuard
        kind="save"
        label="notes/outline.md"
        onCancel={vi.fn()}
        onSaveAs={vi.fn()}
      />,
    );
    expect(screen.getByRole("alertdialog", { name: "Save notes/outline.md?" })).toBeTruthy();
  });
});
