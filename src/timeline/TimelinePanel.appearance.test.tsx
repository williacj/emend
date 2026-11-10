// @vitest-environment jsdom
// ABOUTME: Checks the timeline shell and facet appearance against the 3a/3b design contract.
// ABOUTME: Reads the shipped stylesheet because jsdom does not import app CSS in component tests.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TimelinePanel } from "./TimelinePanel";

const stylesheet = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"), "utf8");
let styleElement: HTMLStyleElement | null = null;

function renderStyledTimeline(platform?: "win" | "mac") {
  styleElement = document.createElement("style");
  styleElement.textContent = stylesheet;
  document.head.append(styleElement);
  const view = render(<TimelinePanel platform={platform} />);
  return view.container.querySelector<HTMLElement>(".timeline-panel")!;
}

function cssRule(selector: string): CSSStyleDeclaration {
  const rule = [...styleElement!.sheet!.cssRules].find(
    (entry): entry is CSSStyleRule => entry instanceof CSSStyleRule &&
      entry.selectorText.split(",").some((part) => part.trim() === selector),
  );
  if (!rule) throw new Error(`Missing CSS rule: ${selector}`);
  return rule.style;
}

afterEach(() => {
  styleElement?.remove();
  styleElement = null;
});

describe("timeline shell appearance (3a/3b, specs/timeline-rail.md)", () => {
  it("claims a 372px authoring lane while workshop keeps the full conversation lane", () => {
    const panel = renderStyledTimeline();
    expect(getComputedStyle(panel).width).toBe("372px");

    panel.parentElement!.classList.add("app-body", "app-body--workshop");
    expect(getComputedStyle(panel).width).toBe("auto");
    expect(getComputedStyle(panel).flexGrow).toBe("1");
  });

  it("uses the win warm rail and control-border palette", () => {
    const panel = renderStyledTimeline("win");
    expect(panel).toHaveAttribute("data-platform", "win");
    expect(getComputedStyle(panel).getPropertyValue("--timeline-rail-bg").trim()).toBe("#f5f3ed");
    expect(getComputedStyle(panel).getPropertyValue("--timeline-facet-border").trim()).toBe("#d5d0c4");
  });

  it("uses the mac warm rail and control-border palette", () => {
    const panel = renderStyledTimeline("mac");
    expect(panel).toHaveAttribute("data-platform", "mac");
    expect(getComputedStyle(panel).getPropertyValue("--timeline-rail-bg").trim()).toBe("#f1eee7");
    expect(getComputedStyle(panel).getPropertyValue("--timeline-facet-border").trim()).toBe("#e3dfd6");
  });

  it("renders five separate compact pills in a padded facet bar", () => {
    const panel = renderStyledTimeline("win");
    const bar = panel.querySelector<HTMLElement>(".timeline-panel__facets")!;
    const pills = [...bar.querySelectorAll<HTMLButtonElement>(".timeline-panel__facet")];
    expect(pills.map((pill) => pill.textContent)).toEqual([
      "All", "Chat", "Comments", "Changes", "Findings",
    ]);
    expect(getComputedStyle(bar).padding).toBe("10px 14px");
    expect(getComputedStyle(bar).gap).toBe("6px");
    expect(getComputedStyle(pills[0]).borderRadius).toBe("12px");
    expect(getComputedStyle(pills[0]).padding).toBe("4px 10px");
    expect(getComputedStyle(pills[0]).fontSize).toBe("11.5px");
    expect(getComputedStyle(pills[0]).fontFamily).toContain("IBM Plex Sans");
    expect(getComputedStyle(pills[0]).flexGrow).toBe("0");
  });

  it("keeps the Windows Address all border and draws the macOS hairline without one", () => {
    renderStyledTimeline("mac");
    const win = cssRule(".timeline-panel__header .batch-address__trigger");
    const mac = cssRule('.timeline-panel[data-platform="mac"] .batch-address__trigger');
    expect(win.border).toBe("1px solid rgb(213, 208, 196)");
    expect(mac.border).toBe("0px");
    expect(mac.boxShadow).toBe("0 0 0 1px #dcd7cc");
    const darkMac = cssRule(':root[data-theme="dark"] .timeline-panel[data-platform="mac"] .batch-address__trigger');
    expect(darkMac.boxShadow).toBe("0 0 0 1px #3a3d42");
  });

  it("matches turn 15 chooser surface, control sizes, primary action and focus palette", () => {
    renderStyledTimeline("win");
    const panel = cssRule(".batch-address__panel");
    expect(panel.background).toBe("rgb(250, 248, 243)");
    expect(panel.padding).toBe("10px");
    expect(panel.gap).toBe("8px");
    expect(panel.minWidth).toBe("220px");
    expect(panel.maxWidth).toBe("320px");
    expect(cssRule(".batch-address__filter select").minWidth).toBe("132px");
    expect(cssRule(".batch-address__include input").width).toBe("14px");
    expect(cssRule(".batch-address__run").background).toBe("rgb(79, 70, 229)");
    expect(cssRule(".batch-address__trigger:focus-visible").outline).toBe("2px solid #4f46e5");
    expect(cssRule(':root[data-theme="dark"] .batch-address__panel').background).toBe("rgb(38, 40, 44)");
    expect(cssRule(':root[data-theme="dark"] .batch-address__run').background).toBe("rgb(165, 176, 255)");
    expect(cssRule(':root[data-theme="dark"] .batch-address__trigger:focus-visible').outlineColor).toBe("rgb(165, 176, 255)");
  });

  it("keeps the overflow invoker painted open while the chooser floats from it", () => {
    renderStyledTimeline("win");
    expect(cssRule('.view-mode-toolbar__overflow-trigger[data-chooser-open="true"]').background).toBe("rgb(240, 237, 230)");
    expect(cssRule(':root[data-theme="dark"] .view-mode-toolbar__overflow-trigger[data-chooser-open="true"]').background).toBe("rgb(58, 61, 66)");
    expect(cssRule('.view-mode-toolbar__overflow-popover [data-toolbar-control="comment-address-all"] .batch-address__trigger').width).toBe("100%");
  });

  it("separates the inline Address all group from formatting with a toolbar hairline", () => {
    renderStyledTimeline("win");
    const slot = cssRule('.view-mode-toolbar > .view-mode-toolbar__control-slot[data-toolbar-control="comment-address-all"]');
    expect(slot.borderLeft).toBe("1px solid rgb(227, 223, 214)");
    expect(slot.paddingLeft).toBe("10px");
    expect(cssRule('.view-mode-toolbar__overflow-popover [data-toolbar-control="comment-address-all"]').borderLeft).toBe("0px");
  });
});
