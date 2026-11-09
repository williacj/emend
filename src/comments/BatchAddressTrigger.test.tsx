// @vitest-environment jsdom
// ABOUTME: Component-level proof of the P2b-3a acceptance criteria: the timeline header's
// ABOUTME: [Address all… ▾] trigger condition and its source/severity/review-pass filter set.
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BatchAddressTrigger } from "./BatchAddressTrigger";
import { thread } from "./threadFixture";
import { ToolbarOverflowContext, type ToolbarOverflowContextValue } from "../editor/ToolbarOverflowSlot";

const TRIGGER = { name: /Address all/ };

describe("BatchAddressTrigger — J4's trigger condition", () => {
  it("does not render with one open comment", () => {
    render(<BatchAddressTrigger threads={[thread("a")]} onAddressAll={vi.fn()} />);
    expect(screen.queryByRole("button", TRIGGER)).toBeNull();
  });

  it("renders with more than one open comment", () => {
    render(<BatchAddressTrigger threads={[thread("a"), thread("b")]} onAddressAll={vi.fn()} />);
    expect(screen.getByRole("button", TRIGGER)).toBeTruthy();
  });

  it("renders when another still-open comment is targeted", () => {
    const threads = [thread("a"), thread("b", { resolved: true }), thread("c", { pending_run: "r" })];
    render(<BatchAddressTrigger threads={threads} onAddressAll={vi.fn()} />);
    expect(screen.getByRole("button", TRIGGER)).toBeTruthy();
  });
});

describe("BatchAddressTrigger — the filter set (FR-CMT-5, J4-Q1)", () => {
  const threads = [
    thread("a", { skill: "style", severity: "low", workflow_run: "run-1" }),
    thread("b", { skill: "biblical-accuracy", severity: "high", workflow_run: "run-2" }),
    thread("c", { severity: "high", workflow_run: "run-1" }),
  ];

  function openPanel(onAddressAll = vi.fn()) {
    render(<BatchAddressTrigger threads={threads} onAddressAll={onAddressAll} />);
    fireEvent.click(screen.getByRole("button", TRIGGER));
    return onAddressAll;
  }

  function expectFirstFilterFocused(floatingPanel: boolean) {
    render(<BatchAddressTrigger threads={threads} onAddressAll={vi.fn()} floatingPanel={floatingPanel} />);
    fireEvent.click(screen.getByRole("button", TRIGGER));
    expect(screen.getByLabelText("Source")).toHaveFocus();
  }

  it("focuses the first filter on opening the inline chooser", () => expectFirstFilterFocused(false));
  it("focuses the first filter on opening the floating chooser", () => expectFirstFilterFocused(true));

  it("keeps focus on the interacted floating control as filters and held inclusion change", () => {
    render(<BatchAddressTrigger floatingPanel onAddressAll={vi.fn()} liveRunIds={["run-live"]}
      threads={[thread("a", { severity: "high", workflow_run: "pass-1" }),
        thread("held", { severity: "high", workflow_run: "pass-1", pending_run: "run-live" })]} />);
    const trigger = screen.getByRole("button", TRIGGER);
    fireEvent.click(trigger);
    const severity = screen.getByLabelText("Severity at least");
    severity.focus();
    fireEvent.change(severity, { target: { value: "high" } });
    expect(severity).toHaveFocus();

    const pass = screen.getByLabelText("Review pass");
    pass.focus();
    fireEvent.change(pass, { target: { value: "pass-1" } });
    expect(pass).toHaveFocus();

    const include = screen.getByRole("checkbox", { name: "include them too" });
    include.focus();
    fireEvent.click(include);
    expect(include).toHaveFocus();

    fireEvent.keyDown(include, { key: "Escape" });
    fireEvent.click(trigger);
    expect(screen.getByLabelText("Source")).toHaveFocus();
  });

  it("returns Escape focus to the supplied visible overflow invoker after its menu closes", () => {
    let visibleInvoker: HTMLButtonElement | null = null;
    render(<ToolbarOverflowContext.Provider value={{
      hidden: new Set(), menuHost: null, registerInline: () => {},
      focusOverflowTrigger: () => { visibleInvoker?.focus(); return visibleInvoker !== null; },
    } satisfies ToolbarOverflowContextValue}>
      <button ref={(node) => { visibleInvoker = node; }} type="button">More editor controls</button>
      <div data-testid="external-overflow-menu">
        <BatchAddressTrigger threads={[thread("a"), thread("b")]} onAddressAll={vi.fn()} floatingPanel />
      </div>
    </ToolbarOverflowContext.Provider>);
    fireEvent.click(screen.getByRole("button", TRIGGER));
    const menu = screen.getByTestId("external-overflow-menu");
    menu.setAttribute("inert", "");
    menu.setAttribute("aria-hidden", "true");
    fireEvent.keyDown(screen.getByLabelText("Source"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Address comments" })).toBeNull();
    expect(visibleInvoker).toHaveFocus();
  });

  it("anchors a moved chooser to the visible overflow button, four pixels below with right edges aligned", () => {
    let visibleInvoker: HTMLButtonElement | null = null;
    render(<ToolbarOverflowContext.Provider value={{
      hidden: new Set(["comment-address-all"]), menuHost: null, registerInline: () => {},
      focusOverflowTrigger: () => false,
      getOverflowTrigger: () => visibleInvoker,
      setChooserOpen: () => {},
    } satisfies ToolbarOverflowContextValue}>
      <button ref={(node) => { visibleInvoker = node; }} type="button">More editor controls</button>
      <BatchAddressTrigger threads={[thread("a"), thread("b")]} onAddressAll={vi.fn()} floatingPanel />
    </ToolbarOverflowContext.Provider>);
    const invoker = screen.getByRole("button", { name: "More editor controls" });
    vi.spyOn(invoker, "getBoundingClientRect").mockReturnValue({ left: 250, right: 278, top: 20, bottom: 46,
      width: 28, height: 26, x: 250, y: 20, toJSON: () => ({}) } as DOMRect);
    fireEvent.click(screen.getByRole("button", TRIGGER));
    const panel = screen.getByRole("dialog", { name: "Address comments" });
    Object.defineProperty(panel, "offsetWidth", { configurable: true, value: 220 });
    Object.defineProperty(panel, "offsetHeight", { configurable: true, value: 180 });
    fireEvent(window, new Event("resize"));
    expect(panel.style.top).toBe("50px");
    expect(panel.style.left).toBe("58px");
  });

  function expectEscapeReturnsFocus(floatingPanel: boolean) {
    render(<BatchAddressTrigger threads={threads} onAddressAll={vi.fn()} floatingPanel={floatingPanel} />);
    const trigger = screen.getByRole("button", TRIGGER);
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByLabelText("Source"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Address comments" })).toBeNull();
    expect(trigger).toHaveFocus();
  }

  it("closes the inline chooser on Escape and returns focus to its trigger", () => expectEscapeReturnsFocus(false));
  it("closes the floating chooser on Escape and returns focus to its trigger", () => expectEscapeReturnsFocus(true));

  function expectOutsideClickPreservesFocus(floatingPanel: boolean) {
    render(<><button>Outside target</button><BatchAddressTrigger threads={threads} onAddressAll={vi.fn()} floatingPanel={floatingPanel} /></>);
    fireEvent.click(screen.getByRole("button", TRIGGER));
    const outside = screen.getByRole("button", { name: "Outside target" });
    outside.focus();
    fireEvent.mouseDown(outside);
    expect(screen.queryByRole("dialog", { name: "Address comments" })).toBeNull();
    expect(outside).toHaveFocus();
  }

  it("closes the inline chooser on an outside click without stealing focus", () => expectOutsideClickPreservesFocus(false));
  it("closes the floating chooser on an outside click without stealing focus", () => expectOutsideClickPreservesFocus(true));

  it("offers all three ratified dimensions (source / severity / review pass)", () => {
    openPanel();
    expect(screen.getByLabelText("Source")).toBeTruthy();
    expect(screen.getByLabelText("Severity at least")).toBeTruthy();
    expect(screen.getByLabelText("Review pass")).toBeTruthy();
  });

  // J4-Q1: "Batch default = all open comments (filters available but not pre-applied)".
  it("pre-applies no filter so every dimension starts on All and all open threads are targeted", () => {
    const onAddressAll = openPanel();
    expect((screen.getByLabelText("Source") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Severity at least") as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Review pass") as HTMLSelectElement).value).toBe("");
    expect(screen.getByRole("button", { name: /Address 3 comments/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Address 3 comments/ }));
    expect(onAddressAll).toHaveBeenCalledWith(["a", "b", "c"], []);
  });

  it("narrows the target set by source", () => {
    const onAddressAll = openPanel();
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "style" } });
    fireEvent.click(screen.getByRole("button", { name: /Address 1 comment\b/ }));
    expect(onAddressAll).toHaveBeenCalledWith(["a"], []);
  });

  it("narrows the target set by severity floor", () => {
    const onAddressAll = openPanel();
    fireEvent.change(screen.getByLabelText("Severity at least"), { target: { value: "medium" } });
    fireEvent.click(screen.getByRole("button", { name: /Address 2 comments/ }));
    expect(onAddressAll).toHaveBeenCalledWith(["b", "c"], []);
  });

  it("narrows the target set by review pass", () => {
    const onAddressAll = openPanel();
    fireEvent.change(screen.getByLabelText("Review pass"), { target: { value: "run-1" } });
    fireEvent.click(screen.getByRole("button", { name: /Address 2 comments/ }));
    expect(onAddressAll).toHaveBeenCalledWith(["a", "c"], []);
  });

  it("disables the run when the filter selects nothing rather than firing an empty batch", () => {
    const onAddressAll = openPanel();
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "style" } });
    fireEvent.change(screen.getByLabelText("Severity at least"), { target: { value: "high" } });
    const run = screen.getByRole("button", { name: /Address 0 comments/ }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.click(run);
    expect(onAddressAll).not.toHaveBeenCalled();
  });

  // The owner of the run tells the trigger a batch is already in flight; a second run's accounting
  // would replace the first's, leaving the FR-AGENT-6 surface reporting the wrong run.
  it("refuses a second run while one is already in flight and says what it is doing", () => {
    const onAddressAll = vi.fn();
    render(<BatchAddressTrigger threads={threads} onAddressAll={onAddressAll} running />);
    fireEvent.click(screen.getByRole("button", TRIGGER));

    const run = screen.getByRole("button", { name: "Addressing…" }) as HTMLButtonElement;
    expect(run.disabled).toBe(true);
    fireEvent.click(run);
    expect(onAddressAll).not.toHaveBeenCalled();
  });
});

describe("BatchAddressTrigger — J4 held-comment choice", () => {
  const threads = [
    thread("a", { skill: "style" }),
    thread("live", { skill: "style", pending_run: "run-live" }),
    thread("queued", { skill: "style", pending_runs: [{ run_id: "run-queued", address_event_id: "a2", started: false, guidance: null, corrected: false }] }),
    thread("other", { skill: "accuracy", pending_run: "run-live" }),
  ];

  it("states the filtered count and excluded count, then submits only unheld IDs by default", () => {
    const onAddressAll = vi.fn();
    render(<BatchAddressTrigger threads={threads} liveRunIds={["run-live", "run-queued"]} onAddressAll={onAddressAll} />);
    fireEvent.click(screen.getByRole("button", TRIGGER));
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "style" } });
    expect(screen.getByText(/3 open comments · 2 already in an agent run/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Address 1 comment\b/ }));
    expect(onAddressAll).toHaveBeenCalledWith(["a"], []);
  });

  it("omits the held-count clause and opt-in when the filtered set has no held comments", () => {
    render(<BatchAddressTrigger threads={[thread("a"), thread("b")]} onAddressAll={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", TRIGGER));
    expect(screen.getByText("Address all · 2 open comments")).toBeTruthy();
    expect(screen.queryByText(/already in an agent run/)).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "include them too" })).toBeNull();
  });

  it("includes only currently held filtered IDs after a focusable native opt-in", () => {
    const onAddressAll = vi.fn();
    render(<BatchAddressTrigger threads={threads} liveRunIds={["run-live", "run-queued"]} onAddressAll={onAddressAll} />);
    fireEvent.click(screen.getByRole("button", TRIGGER));
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "style" } });
    const include = screen.getByRole("checkbox", { name: "include them too" });
    include.focus();
    expect((include as HTMLInputElement).tabIndex).toBe(0);
    expect(document.getElementById(include.getAttribute("aria-describedby") ?? "")?.textContent)
      .toContain("3 open comments · 2 already in an agent run");
    fireEvent.click(include);
    expect(document.activeElement).toBe(include);
    fireEvent.click(screen.getByRole("button", { name: /Address 3 comments/ }));
    expect(onAddressAll).toHaveBeenCalledWith(["a", "live", "queued"], ["live", "queued"]);
  });

  it("drops opt-in when the held set changes, then recomputes when a run ends", () => {
    const onAddressAll = vi.fn();
    const { rerender } = render(<BatchAddressTrigger threads={threads.slice(0, 3)} liveRunIds={["run-live", "run-queued"]} onAddressAll={onAddressAll} />);
    fireEvent.click(screen.getByRole("button", TRIGGER));
    fireEvent.click(screen.getByRole("checkbox", { name: "include them too" }));
    expect(screen.getByRole("button", { name: /Address 3 comments/ })).toBeTruthy();
    rerender(<BatchAddressTrigger threads={[...threads.slice(0, 3), thread("new", { pending_run: "run-new" })]} liveRunIds={["run-live", "run-queued", "run-new"]} onAddressAll={onAddressAll} />);
    expect((screen.getByRole("checkbox", { name: "include them too" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Address 1 comment\b/ }));
    expect(onAddressAll).toHaveBeenCalledWith(["a"], []);
    rerender(<BatchAddressTrigger threads={[...threads.slice(0, 3), thread("new", { pending_run: "run-new" })]} liveRunIds={["run-live", "run-queued"]} terminalRunIds={["run-new"]} onAddressAll={onAddressAll} />);
    fireEvent.click(screen.getByRole("button", TRIGGER));
    expect(screen.getByText(/4 open comments · 2 already in an agent run/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Address 2 comments/ })).toBeTruthy();
  });

  it("keeps a chosen source visible when its last thread closes, without widening to All", () => {
    const onAddressAll = vi.fn();
    const before = [thread("style", { skill: "style" }), thread("a"), thread("b")];
    const { rerender } = render(<BatchAddressTrigger threads={before} onAddressAll={onAddressAll} />);
    fireEvent.click(screen.getByRole("button", TRIGGER));
    fireEvent.change(screen.getByLabelText("Source"), { target: { value: "style" } });
    rerender(<BatchAddressTrigger threads={[thread("style", { skill: "style", resolved: true }), thread("a"), thread("b")]} onAddressAll={onAddressAll} />);
    expect((screen.getByLabelText("Source") as HTMLSelectElement).value).toBe("style");
    expect(screen.getByText("Address all · 0 open comments")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Address 0 comments" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("remains available with two open comments even when both are held", () => {
    render(<BatchAddressTrigger threads={threads.slice(1, 3)} liveRunIds={["run-live", "run-queued"]} onAddressAll={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", TRIGGER));
    expect(screen.getByText("Address all · 2 open comments · 2 already in an agent run —")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Address 0 comments/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "include them too" }));
    expect((screen.getByRole("button", { name: /Address 2 comments/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
