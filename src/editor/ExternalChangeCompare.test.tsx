// @vitest-environment jsdom
// ABOUTME: Tests for the external-change Compare view (P2a-21, FR-ED-7) — v1 side-by-side, both
// ABOUTME: versions' text shown verbatim, closable back to the banner.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExternalChangeCompare } from "./ExternalChangeCompare";

describe("editor/ExternalChangeCompare", () => {
  it("is not a dialog — an inline region closable rather than modal", () => {
    render(
      <ExternalChangeCompare path="a.md" localContent="mine" diskContent="theirs" onClose={vi.fn()} />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows both versions' text verbatim side by side", () => {
    render(
      <ExternalChangeCompare
        path="a.md"
        localContent="local text"
        diskContent="disk text"
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("local text")).toBeTruthy();
    expect(screen.getByText("disk text")).toBeTruthy();
  });

  it("Close fires onClose", () => {
    const onClose = vi.fn();
    render(<ExternalChangeCompare path="a.md" localContent="a" diskContent="b" onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
