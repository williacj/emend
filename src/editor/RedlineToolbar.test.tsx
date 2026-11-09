// @vitest-environment jsdom
// ABOUTME: Component proof of the P2a-5 toolbar acceptance: `[✓ Accept][✗ Reject] ◀ n/N ▶` nav
// ABOUTME: (J1 wireframe), inert with no pending changes.
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RedlineToolbar } from "./RedlineToolbar";

describe("editor/RedlineToolbar", () => {
  it("shows the current position n / N", () => {
    render(
      <RedlineToolbar count={3} position={2} onAccept={vi.fn()} onReject={vi.fn()} onPrev={vi.fn()} onNext={vi.fn()} />,
    );
    expect(screen.getByText("2 / 3")).toBeTruthy();
  });

  it("wires accept / reject / prev / next", () => {
    const h = { onAccept: vi.fn(), onReject: vi.fn(), onPrev: vi.fn(), onNext: vi.fn() };
    render(<RedlineToolbar count={3} position={1} {...h} />);
    fireEvent.click(screen.getByRole("button", { name: "✓ Accept" }));
    fireEvent.click(screen.getByRole("button", { name: "✗ Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous change" }));
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    expect(h.onAccept).toHaveBeenCalledTimes(1);
    expect(h.onReject).toHaveBeenCalledTimes(1);
    expect(h.onPrev).toHaveBeenCalledTimes(1);
    expect(h.onNext).toHaveBeenCalledTimes(1);
  });

  it("is inert (buttons disabled, 0 / 0) when there are no pending changes", () => {
    render(
      <RedlineToolbar count={0} position={0} onAccept={vi.fn()} onReject={vi.fn()} onPrev={vi.fn()} onNext={vi.fn()} />,
    );
    expect(screen.getByText("0 / 0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "✓ Accept" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Next change" })).toHaveProperty("disabled", true);
  });

  // P2b-2 / ux-design §4: the type-filtered bulk dropdown lives in the same track-changes cluster
  // row as nav/accept-reject, not as a separate unstyled row — `RedlineReview` composes it in via
  // this slot rather than rendering it as a sibling.
  it("renders a trailing child inside its own toolbar row rather than displacing it", () => {
    render(
      <RedlineToolbar count={0} position={0} onAccept={vi.fn()} onReject={vi.fn()} onPrev={vi.fn()} onNext={vi.fn()}>
        <button type="button">Type-filtered</button>
      </RedlineToolbar>,
    );
    const toolbar = screen.getByRole("toolbar", { name: "Review changes" });
    expect(within(toolbar).getByRole("button", { name: "Type-filtered" })).toBeTruthy();
  });
});
