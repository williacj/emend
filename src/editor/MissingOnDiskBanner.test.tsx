// @vitest-environment jsdom
// ABOUTME: Tests for J2's Missing-on-disk banner (#933) — exact ux-design copy, no Reload/Compare
// ABOUTME: while no disk version exists, Recreate present only under proven confinement, and the
// ABOUTME: recorded recovery-failure state keeping Save As available.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MissingOnDiskBanner } from "./MissingOnDiskBanner";

const handlers = () => ({
  onKeepEditing: vi.fn(),
  onSaveAs: vi.fn(),
  onClose: vi.fn(),
  onRecreate: vi.fn(),
});

describe("editor/MissingOnDiskBanner", () => {
  it("is non-modal — a status banner across the editor top, never a dialog over the text", () => {
    render(<MissingOnDiskBanner recreatable={false} failure={null} {...handlers()} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows the recorded copy, the paused-autosave readout, and no Reload or Compare", () => {
    render(<MissingOnDiskBanner recreatable={false} failure={null} {...handlers()} />);

    expect(
      screen.getByText("This file is missing from its project path. Your open copy is safe."),
    ).toBeTruthy();
    expect(screen.getByText("Autosave paused — file missing")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep editing" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save As…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close…" })).toBeTruthy();
    // There is no disk version to reload from or compare against while the file is absent.
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Compare" })).toBeNull();
  });

  it("offers Recreate only when the backend proved confinement for this path", () => {
    render(<MissingOnDiskBanner recreatable={false} failure={null} {...handlers()} />);
    // macOS and every unsupported filesystem: the action is absent, not disabled — offering a
    // control Cowrite cannot honor is the promise TD-18's gate exists to refuse.
    expect(screen.queryByRole("button", { name: "Recreate" })).toBeNull();
    cleanup();

    render(<MissingOnDiskBanner recreatable failure={null} {...handlers()} />);
    expect(screen.getByRole("button", { name: "Recreate" })).toBeTruthy();
  });

  it("reports lost confinement in the recorded words, keeping Save As available", () => {
    render(<MissingOnDiskBanner recreatable failure={{ kind: "confinement" }} {...handlers()} />);

    expect(
      screen.getByText("Emend can’t safely recreate this file at its original path."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save As…" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep editing" })).toBeTruthy();
    // Recreate is gone even though the capability query had said yes: this failure *is* the
    // capability disappearing, so re-offering it would invite the same refusal again.
    expect(screen.queryByRole("button", { name: "Recreate" })).toBeNull();
  });

  it("reports any other failure with its detail", () => {
    render(
      <MissingOnDiskBanner
        recreatable
        failure={{ kind: "error", detail: "permission denied" }}
        {...handlers()}
      />,
    );

    expect(
      screen.getByText("Emend couldn’t complete the requested action. permission denied"),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save As…" })).toBeTruthy();
  });

  it("each action fires its own callback", () => {
    const h = handlers();
    render(<MissingOnDiskBanner recreatable failure={null} {...h} />);

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Save As…" }));
    fireEvent.click(screen.getByRole("button", { name: "Close…" }));
    fireEvent.click(screen.getByRole("button", { name: "Recreate" }));

    expect(h.onKeepEditing).toHaveBeenCalledTimes(1);
    expect(h.onSaveAs).toHaveBeenCalledTimes(1);
    expect(h.onClose).toHaveBeenCalledTimes(1);
    expect(h.onRecreate).toHaveBeenCalledTimes(1);
  });

  it("does not steal focus on mount — the file disappeared while the user was typing", () => {
    render(<MissingOnDiskBanner recreatable failure={null} {...handlers()} />);
    for (const name of ["Keep editing", "Save As…", "Close…", "Recreate"]) {
      const button = screen.getByRole("button", { name });
      expect(button.hasAttribute("autofocus")).toBe(false);
      expect(document.activeElement).not.toBe(button);
    }
  });
});
