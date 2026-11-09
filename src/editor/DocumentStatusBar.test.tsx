// @vitest-environment jsdom
// ABOUTME: Pins UXR-Q7.2's reusable document status-bar shell, platform chrome, and measured
// ABOUTME: right-cluster overflow without assigning any of the downstream status items here.
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocumentStatusBar, type DocumentStatusBarTrailingItem } from "./DocumentStatusBar";

const STYLESHEET = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../styles.css"),
  "utf8",
);

let resize: (() => void) | null = null;
const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

class ResizeObserverStub {
  constructor(callback: ResizeObserverCallback) {
    resize = () => callback([], this as unknown as ResizeObserver);
  }

  observe() {}
  disconnect() {}
  unobserve() {}
}

function item(
  id: string,
  label: string,
  onOverflowSelect: () => void = () => {},
): DocumentStatusBarTrailingItem {
  return {
    id,
    content: <button type="button">{label}</button>,
    overflowEntries: [{ id: `${id}-action`, label, onSelect: onOverflowSelect }],
  };
}

afterEach(() => {
  resize = null;
  if (originalResizeObserver) {
    Object.defineProperty(globalThis, "ResizeObserver", originalResizeObserver);
  } else {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  }
  if (originalOffsetWidth) {
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", originalOffsetWidth);
  }
  document.head.replaceChildren();
});

describe("editor/DocumentStatusBar (#2253, UXR-Q7.2)", () => {
  it("renders named leading and trailing slots in one persistent platform row", () => {
    render(
      <DocumentStatusBar
        platform="win"
        leadingItems={[item("mode", "Markdown"), item("words", "1,208 words")]}
        trailingItems={[item("display", "Display"), item("saved", "Saved")]}
      />,
    );

    const bar = screen.getByRole("region", { name: "Document status" });
    expect(bar).toHaveAttribute("data-platform", "win");
    expect(within(bar).getByRole("button", { name: "Markdown" })).toBeVisible();
    expect(within(bar).getByRole("button", { name: "1,208 words" })).toBeVisible();
    expect(within(bar).getByRole("button", { name: "Display" })).toBeVisible();
    expect(within(bar).getByRole("button", { name: "Saved" })).toBeVisible();
    expect(within(bar).queryByRole("button", { name: "More document status" })).toBeNull();
  });

  it("keeps the left cluster and overflows right items from the declared trailing edge", () => {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverStub,
    });
    let width = 300;
    const { container } = render(
      <DocumentStatusBar
        platform="win"
        leadingItems={[item("mode", "Markdown"), item("words", "1,208 words")]}
        trailingItems={[
          item("display", "Display"),
          item("saved", "Saved"),
          item("connection", "Connected"),
        ]}
      />,
    );

    const bar = container.querySelector<HTMLElement>(".document-status-bar")!;
    const leading = container.querySelector<HTMLElement>(".document-status-bar__leading")!;
    const overflowMeasure = container.querySelector<HTMLElement>(
      ".document-status-bar__overflow-measure",
    )!;
    Object.defineProperty(bar, "clientWidth", { configurable: true, get: () => width });
    Object.defineProperty(leading, "scrollWidth", { configurable: true, value: 100 });
    Object.defineProperty(overflowMeasure, "offsetWidth", { configurable: true, value: 28 });
    for (const element of container.querySelectorAll<HTMLElement>("[data-status-item-id]")) {
      Object.defineProperty(element, "offsetWidth", { configurable: true, value: 80 });
    }

    act(() => resize?.());

    expect(screen.getByRole("button", { name: "Markdown" })).toBeVisible();
    expect(screen.getByRole("button", { name: "1,208 words" })).toBeVisible();
    const visibleTrailing = container.querySelectorAll(
      ".document-status-bar__trailing-item [type='button']",
    );
    expect([...visibleTrailing].map((element) => element.textContent)).toEqual(["Display"]);

    const more = screen.getByRole("button", { name: "More document status" });
    fireEvent.click(more);
    const menu = screen.getByRole("menu", { name: "More document status" });
    expect(within(menu).getByRole("menuitem", { name: "Saved" })).toBeVisible();
    expect(within(menu).getByRole("menuitem", { name: "Connected" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(more).toHaveAttribute("aria-expanded", "false");

    width = 450;
    act(() => resize?.());

    expect(screen.queryByRole("button", { name: "More document status" })).toBeNull();
    expect(screen.getByRole("button", { name: "Display" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Saved" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Connected" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Document status" })).toBe(bar);
  });

  it("exposes an overflowed readout as an accessible disabled fact, not a fake action", () => {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverStub,
    });
    const { container } = render(
      <DocumentStatusBar
        platform="win"
        trailingItems={[
          item("display", "Display"),
          {
            id: "saved",
            content: <span>Reloaded from disk · not saved yet</span>,
            overflowEntries: [
              {
                id: "save-state",
                label: "Reloaded from disk · not saved yet",
                disabled: true,
              },
            ],
          },
        ]}
      />,
    );
    const bar = container.querySelector<HTMLElement>(".document-status-bar")!;
    const leading = container.querySelector<HTMLElement>(".document-status-bar__leading")!;
    const overflowMeasure = container.querySelector<HTMLElement>(
      ".document-status-bar__overflow-measure",
    )!;
    Object.defineProperty(bar, "clientWidth", { configurable: true, value: 120 });
    Object.defineProperty(leading, "scrollWidth", { configurable: true, value: 0 });
    Object.defineProperty(overflowMeasure, "offsetWidth", { configurable: true, value: 28 });
    for (const element of container.querySelectorAll<HTMLElement>("[data-status-item-id]")) {
      Object.defineProperty(element, "offsetWidth", { configurable: true, value: 80 });
    }
    act(() => resize?.());

    fireEvent.click(screen.getByRole("button", { name: "More document status" }));
    expect(
      screen.getByRole("menuitem", { name: "Reloaded from disk · not saved yet" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("remeasures a hidden stable-ID item when its content shrinks enough to fit", () => {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverStub,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        if (this.classList.contains("document-status-bar__overflow-measure")) return 28;
        const id = this.getAttribute("data-status-item-id");
        if (id === "saved") return this.textContent === "S" ? 20 : 80;
        return id ? 80 : 0;
      },
    });
    const leadingItems = [item("mode", "Markdown"), item("words", "1,208 words")];
    const { container, rerender } = render(
      <DocumentStatusBar
        platform="win"
        leadingItems={leadingItems}
        trailingItems={[
          item("display", "Display"),
          item("saved", "Saved"),
          item("connection", "Connected"),
        ]}
      />,
    );
    const bar = container.querySelector<HTMLElement>(".document-status-bar")!;
    const leading = container.querySelector<HTMLElement>(".document-status-bar__leading")!;
    Object.defineProperty(bar, "clientWidth", { configurable: true, value: 320 });
    Object.defineProperty(leading, "scrollWidth", { configurable: true, value: 100 });
    act(() => resize?.());
    expect(
      [...container.querySelectorAll(".document-status-bar__trailing-item")].map(
        (element) => element.textContent,
      ),
    ).toEqual(["Display"]);

    rerender(
      <DocumentStatusBar
        platform="win"
        leadingItems={leadingItems}
        trailingItems={[
          item("display", "Display"),
          item("saved", "S"),
          item("connection", "Connected"),
        ]}
      />,
    );

    expect(
      [...container.querySelectorAll(".document-status-bar__trailing-item")].map(
        (element) => element.textContent,
      ),
    ).toEqual(["Display", "S"]);
  });

  it("opens an icon-backed menu with roving focus and restores focus on Escape", () => {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverStub,
    });
    const selectSaved = vi.fn();
    const { container } = render(
      <DocumentStatusBar
        platform="win"
        leadingItems={[item("mode", "Markdown"), item("words", "1,208 words")]}
        trailingItems={[
          item("display", "Display"),
          item("saved", "Saved", selectSaved),
          item("connection", "Connected"),
        ]}
      />,
    );
    const bar = container.querySelector<HTMLElement>(".document-status-bar")!;
    const leading = container.querySelector<HTMLElement>(".document-status-bar__leading")!;
    const overflowMeasure = container.querySelector<HTMLElement>(
      ".document-status-bar__overflow-measure",
    )!;
    Object.defineProperty(bar, "clientWidth", { configurable: true, value: 300 });
    Object.defineProperty(leading, "scrollWidth", { configurable: true, value: 100 });
    Object.defineProperty(overflowMeasure, "offsetWidth", { configurable: true, value: 28 });
    for (const element of container.querySelectorAll<HTMLElement>("[data-status-item-id]")) {
      Object.defineProperty(element, "offsetWidth", { configurable: true, value: 80 });
    }
    act(() => resize?.());

    const more = screen.getByRole("button", { name: "More document status" });
    expect(more.querySelector(".lucide-ellipsis")).not.toBeNull();
    expect(more).not.toHaveTextContent("⋯");
    expect(overflowMeasure.querySelector(".lucide-ellipsis")).not.toBeNull();
    fireEvent.click(more);

    const menu = screen.getByRole("menu", { name: "More document status" });
    const menuItems = within(menu).getAllByRole("menuitem");
    expect(menuItems).toHaveLength(2);
    expect(menuItems[0]).toHaveFocus();
    fireEvent.keyDown(menuItems[0], { key: "ArrowDown" });
    expect(menuItems[1]).toHaveFocus();
    fireEvent.keyDown(menuItems[1], { key: "ArrowDown" });
    expect(menuItems[0]).toHaveFocus();
    fireEvent.keyDown(menuItems[0], { key: "ArrowUp" });
    expect(menuItems[1]).toHaveFocus();
    fireEvent.keyDown(menuItems[1], { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "More document status" })).toBeNull();
    expect(more).toHaveFocus();

    fireEvent.keyDown(more, { key: "ArrowDown" });
    const saved = screen.getByRole("menuitem", { name: "Saved" });
    expect(saved).toHaveFocus();
    fireEvent.keyDown(saved, { key: "Enter" });
    expect(selectSaved).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu", { name: "More document status" })).toBeNull();
    expect(more).toHaveFocus();
  });

  it("keeps every choice of an overflowed status control keyboard-operable", () => {
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: ResizeObserverStub,
    });
    const selectNone = vi.fn();
    const { container } = render(
      <DocumentStatusBar
        platform="win"
        leadingItems={[item("words", "1,208 words")]}
        trailingItems={[
          {
            id: "display",
            content: (
              <select aria-label="Display mode">
                <option>All</option>
              </select>
            ),
            overflowEntries: [
              { id: "all", label: "Display: All", checked: true, onSelect: () => {} },
              { id: "simple", label: "Display: Simple", checked: false, onSelect: () => {} },
              { id: "none", label: "Display: None", checked: false, onSelect: selectNone },
              { id: "original", label: "Display: Original", checked: false, onSelect: () => {} },
            ],
          },
        ]}
      />,
    );
    const bar = container.querySelector<HTMLElement>(".document-status-bar")!;
    const leading = container.querySelector<HTMLElement>(".document-status-bar__leading")!;
    const overflowMeasure = container.querySelector<HTMLElement>(
      ".document-status-bar__overflow-measure",
    )!;
    Object.defineProperty(bar, "clientWidth", { configurable: true, value: 100 });
    Object.defineProperty(leading, "scrollWidth", { configurable: true, value: 80 });
    Object.defineProperty(overflowMeasure, "offsetWidth", { configurable: true, value: 28 });
    for (const element of container.querySelectorAll<HTMLElement>("[data-status-item-id]")) {
      Object.defineProperty(element, "offsetWidth", { configurable: true, value: 80 });
    }
    act(() => resize?.());

    fireEvent.click(screen.getByRole("button", { name: "More document status" }));
    const choices = screen.getAllByRole("menuitemradio");
    expect(choices.map((choice) => choice.textContent)).toEqual([
      "Display: All",
      "Display: Simple",
      "Display: None",
      "Display: Original",
    ]);
    expect(choices[0]).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(choices[0], { key: "End" });
    expect(choices[3]).toHaveFocus();
    fireEvent.keyDown(choices[3], { key: "ArrowDown" });
    expect(choices[0]).toHaveFocus();
    fireEvent.click(choices[2]);
    expect(selectNone).toHaveBeenCalledOnce();
  });

  it("binds exact one-row platform styling to the status-bar selectors", () => {
    const style = document.createElement("style");
    style.textContent = STYLESHEET;
    document.head.append(style);
    render(
      <>
        <DocumentStatusBar platform="win" />
        <DocumentStatusBar platform="mac" />
      </>,
    );

    const [win, mac] = screen.getAllByRole("region", { name: "Document status" });
    const winStyle = getComputedStyle(win);
    const macStyle = getComputedStyle(mac);
    expect(winStyle.display).toBe("flex");
    expect(winStyle.flexWrap).toBe("nowrap");
    expect(winStyle.padding).toBe("8px 16px");
    expect(winStyle.fontSize).toBe("11.5px");
    expect(winStyle.whiteSpace).toBe("nowrap");
    expect(winStyle.backgroundColor).toBe("var(--color-document-status-win-bg)");
    expect(macStyle.backgroundColor).toBe("var(--color-document-status-mac-bg)");

    const rootStyle = getComputedStyle(document.documentElement);
    expect(rootStyle.getPropertyValue("--color-document-status-win-bg").trim()).toBe("#f5f3ed");
    expect(rootStyle.getPropertyValue("--color-document-status-mac-bg").trim()).toBe("#f1eee7");
    expect(rootStyle.getPropertyValue("--color-document-status-border").trim()).toBe("#e3dfd6");
    expect(rootStyle.getPropertyValue("--color-document-status-fg").trim()).toBe("#6b665c");
  });
});
