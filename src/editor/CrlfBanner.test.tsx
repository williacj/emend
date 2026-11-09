// @vitest-environment jsdom
// ABOUTME: Tests for the CRLF integrity banner (P2a-21, FR-ED-2) — non-modal, exact ux-design copy,
// ABOUTME: and each action fires its own callback.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CrlfBanner } from "./CrlfBanner";

describe("editor/CrlfBanner", () => {
  it("is non-modal — a status banner rather than a dialog", () => {
    render(<CrlfBanner onOk={vi.fn()} onDontConvert={vi.fn()} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows the exact ux-design copy", () => {
    render(<CrlfBanner onOk={vi.fn()} onDontConvert={vi.fn()} />);
    expect(screen.getByText("Line endings will be normalized to LF on save")).toBeTruthy();
  });

  it("OK fires onOk", () => {
    const onOk = vi.fn();
    render(<CrlfBanner onOk={onOk} onDontConvert={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(onOk).toHaveBeenCalledTimes(1);
  });

  it("Don't convert this file fires onDontConvert", () => {
    const onDontConvert = vi.fn();
    render(<CrlfBanner onOk={vi.fn()} onDontConvert={onDontConvert} />);
    fireEvent.click(screen.getByRole("button", { name: "Don't convert this file" }));
    expect(onDontConvert).toHaveBeenCalledTimes(1);
  });
});
