// @vitest-environment jsdom
// ABOUTME: Pins the 9c.8 session-write failure dialog's risk copy, actions, and keyboard contract.
// ABOUTME: Covers zero/plural affected sets and the retained-plan retry busy state.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SessionWriteFailureDialog } from "./SessionWriteFailureDialog";

describe("SessionWriteFailureDialog", () => {
  it("renders all affected labels, exact action order, and focuses Stay open", () => {
    render(<SessionWriteFailureDialog affectedLabels={["a.md", "b.md"]} detail="Permission denied" baseline="prior" retrying={false} onQuitAnyway={vi.fn()} onRetry={vi.fn()} onStayOpen={vi.fn()} />);

    expect(screen.getByRole("alertdialog")).toHaveTextContent("Changes to 2 untitled documents may not return");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(["a.md", "b.md"]);
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Quit anyway", "Try again", "Stay open"]);
    expect(screen.getByRole("button", { name: "Stay open" })).toHaveFocus();
  });

  it("uses the zero-tab layout risk copy and Escape stays open", () => {
    const onStayOpen = vi.fn();
    render(<SessionWriteFailureDialog affectedLabels={[]} detail="Disk full" baseline="unknown" retrying={false} onQuitAnyway={vi.fn()} onRetry={vi.fn()} onStayOpen={onStayOpen} />);

    expect(screen.getByRole("alertdialog")).toHaveTextContent("latest tab layout and session state may not return");
    fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
    expect(onStayOpen).toHaveBeenCalledOnce();
  });

  it("disables every action while one retry is in flight", () => {
    render(<SessionWriteFailureDialog affectedLabels={["a.md"]} detail="offline" baseline="none" retrying onQuitAnyway={vi.fn()} onRetry={vi.fn()} onStayOpen={vi.fn()} />);
    expect(screen.getByRole("alertdialog")).toHaveAttribute("aria-busy", "true");
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });

  it("makes the bounded affected list keyboard reachable only when it overflows", () => {
    const scrollHeight = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(120);
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(96);
    render(<SessionWriteFailureDialog affectedLabels={["a.md", "b.md"]} detail="offline" baseline="prior" retrying={false} onQuitAnyway={vi.fn()} onRetry={vi.fn()} onStayOpen={vi.fn()} />);

    const list = screen.getByRole("list");
    const stay = screen.getByRole("button", { name: "Stay open" });
    expect(list).toHaveAttribute("tabindex", "0");

    // The scroll region is the first modal stop when it exists: forward Tab from the last action
    // wraps to it, and reverse Tab from it wraps back to the last action.
    fireEvent.keyDown(stay, { key: "Tab" });
    expect(list).toHaveFocus();
    fireEvent.keyDown(list, { key: "Tab", shiftKey: true });
    expect(stay).toHaveFocus();

    scrollHeight.mockRestore();
    clientHeight.mockRestore();
  });
});
