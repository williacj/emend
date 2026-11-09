// @vitest-environment jsdom
// ABOUTME: Component proof of the P2a-5 popover acceptance: old→new + agent note, with Accept/Reject
// ABOUTME: buttons and Escape-to-dismiss (J1 Phase C wireframe).
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RedlinePopover, type RedlinePopoverChange } from "./RedlinePopover";

const sub: RedlinePopoverChange = { kind: "substitution", oldText: "over", newText: "above", note: "clearer" };

describe("editor/RedlinePopover", () => {
  it("shows old→new text and the agent note for a substitution", () => {
    render(<RedlinePopover change={sub} onAccept={vi.fn()} onReject={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText("Removed text").textContent).toBe("over");
    expect(screen.getByLabelText("Added text").textContent).toBe("above");
    expect(screen.getByText("clearer")).toBeTruthy();
  });

  it("shows only the added side for an insertion (no note)", () => {
    render(
      <RedlinePopover
        change={{ kind: "insertion", oldText: "", newText: "quick " }}
        onAccept={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Added text").textContent).toBe("quick ");
    expect(screen.queryByLabelText("Removed text")).toBeNull();
  });

  it("fires onAccept / onReject from the buttons", () => {
    const onAccept = vi.fn();
    const onReject = vi.fn();
    render(<RedlinePopover change={sub} onAccept={onAccept} onReject={onReject} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "✓ Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "✗ Reject" }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it("dismisses on Escape without deciding", () => {
    const onClose = vi.fn();
    const onAccept = vi.fn();
    render(<RedlinePopover change={sub} onAccept={onAccept} onReject={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onAccept).not.toHaveBeenCalled();
  });
});
