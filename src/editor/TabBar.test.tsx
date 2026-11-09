// @vitest-environment jsdom
// ABOUTME: Keyboard reachability for the tab strip (P2a-6, FR-ED-3 / T2) — the WAI-ARIA
// ABOUTME: tablist roving-tabindex contract: Arrow/Home/End move + select, Enter/Space activate —
// ABOUTME: plus the strip's own presentation against the shipped stylesheet (#1116, hi-fi 3a/3b).
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TabRecord } from "../stores/tabs";
import { TabBar, type TabBarPlatform } from "./TabBar";

// The app's real stylesheet, as text — see `renderStyledBar` below. Read through `node:fs` rather
// than imported: Vitest's default `css: false` stubs a CSS import (even `?raw`) out to an empty
// string, and Vite rewrites the `new URL("…", import.meta.url)` idiom into a dev-server URL, so
// `dirname(fileURLToPath(import.meta.url))` is the one form that survives both.
const STYLESHEET = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "styles.css"),
  "utf8",
);

function tab(path: string, dirty = false): TabRecord {
  return { path, dirty };
}

/** An untitled recovery document's tab: an opaque identity plus the origin that classifies it. */
function recoveredTab(
  identity: string,
  displacedFrom: string,
  recoveryContentOmitted = false,
  displacedLabelOrdinal?: number,
): TabRecord {
  return {
    path: identity,
    dirty: false,
    recoveredFrom: displacedFrom,
    ...(recoveryContentOmitted ? { recoveryContentOmitted: true } : {}),
    ...(displacedLabelOrdinal === undefined ? {} : { displacedLabelOrdinal }),
  };
}

const tabs = [tab("a.md"), tab("b.md"), tab("c.md")];

function renderBar(activePath: string, onSelect = vi.fn()) {
  render(
    <TabBar tabs={tabs} activePath={activePath} onSelect={onSelect} onRequestClose={vi.fn()} />,
  );
  return onSelect;
}

let styleElement: HTMLStyleElement | null = null;

/**
 * Renders the strip with the app's real stylesheet attached and returns the tablist element.
 *
 * jsdom applies no stylesheet on its own, which is exactly how #1116 shipped: `TabBar` had no
 * `.tab-bar` rules at all, so every open document laid out as a full-width block row and this suite
 * could not see it. jsdom does resolve the cascade (attribute selectors included) for
 * `getComputedStyle` even though it performs no layout, so loading the shipped CSS here keeps the
 * strip's own geometry — the part of this component that *is* the bug — executed.
 */
function renderStyledBar(
  activePath: string,
  platform: TabBarPlatform,
  tabList: TabRecord[] = tabs,
  liveOverCapPaths?: ReadonlySet<string>,
): HTMLElement {
  styleElement = document.createElement("style");
  styleElement.textContent = STYLESHEET;
  document.head.append(styleElement);
  render(
    <TabBar
      tabs={tabList}
      activePath={activePath}
      platform={platform}
      onSelect={vi.fn()}
      onRequestClose={vi.fn()}
      liveOverCapPaths={liveOverCapPaths}
    />,
  );
  return screen.getByRole("tablist");
}

afterEach(() => {
  styleElement?.remove();
  styleElement = null;
});

describe("editor/TabBar — keyboard reachability (roving tabindex)", () => {
  it("only the active tab is in the tab order; the rest carry tabIndex -1", () => {
    renderBar("b.md");
    expect(screen.getByRole("tab", { name: /a\.md/ })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tab", { name: /b\.md/ })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: /c\.md/ })).toHaveAttribute("tabindex", "-1");
  });

  it("ArrowRight selects the next tab and wraps past the last", () => {
    const onSelect = renderBar("b.md");
    fireEvent.keyDown(screen.getByRole("tab", { name: /b\.md/ }), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("c.md");

    onSelect.mockClear();
    render(
      <TabBar tabs={tabs} activePath="c.md" onSelect={onSelect} onRequestClose={vi.fn()} />,
    );
    fireEvent.keyDown(screen.getAllByRole("tab", { name: /c\.md/ })[1], { key: "ArrowRight" });
    expect(onSelect).toHaveBeenCalledWith("a.md");
  });

  it("ArrowLeft selects the previous tab and wraps before the first", () => {
    const onSelect = renderBar("a.md");
    fireEvent.keyDown(screen.getByRole("tab", { name: /a\.md/ }), { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenCalledWith("c.md");
  });

  it("Home selects the first tab and End the last", () => {
    const onSelect = renderBar("b.md");
    fireEvent.keyDown(screen.getByRole("tab", { name: /b\.md/ }), { key: "Home" });
    expect(onSelect).toHaveBeenCalledWith("a.md");
    fireEvent.keyDown(screen.getByRole("tab", { name: /b\.md/ }), { key: "End" });
    expect(onSelect).toHaveBeenCalledWith("c.md");
  });

  it("Enter and Space activate the focused tab", () => {
    const onSelect = renderBar("b.md");
    fireEvent.keyDown(screen.getByRole("tab", { name: /a\.md/ }), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("a.md");
    fireEvent.keyDown(screen.getByRole("tab", { name: /c\.md/ }), { key: " " });
    expect(onSelect).toHaveBeenCalledWith("c.md");
  });

  it("ignores keys it does not handle", () => {
    const onSelect = renderBar("b.md");
    fireEvent.keyDown(screen.getByRole("tab", { name: /b\.md/ }), { key: "x" });
    expect(onSelect).not.toHaveBeenCalled();
  });
});

describe("editor/TabBar — the tabbed authoring center (#1116, hi-fi 3a/3b)", () => {
  it("lays every open document out in one horizontal strip, not a stacked row each", () => {
    const strip = renderStyledBar("b.md", "win");
    const stripStyle = getComputedStyle(strip);
    expect(stripStyle.display).toBe("flex");
    // A wrapping strip is the stacked-rows bug in another guise: ux-design §4's tabbed authoring
    // center is a single strip above the toolbar, not however many rows the tabs need.
    expect(stripStyle.flexWrap).toBe("nowrap");

    const openTabs = screen.getAllByRole("tab");
    expect(openTabs).toHaveLength(3);
    for (const openTab of openTabs) {
      expect(openTab.parentElement).toBe(strip);
      // Each tab is its own inline row of dot + label + close, sized to its content.
      expect(getComputedStyle(openTab).display).toBe("flex");
    }
  });

  it("draws Windows folder tabs (platform-variants.md 'Document tabs')", () => {
    const strip = renderStyledBar("b.md", "win");
    expect(strip).toHaveAttribute("data-platform", "win");
    expect(getComputedStyle(strip).padding).toBe("8px 12px 0px");
    expect(getComputedStyle(strip).gap).toBe("2px");

    const active = getComputedStyle(screen.getByRole("tab", { name: /b\.md/ }));
    expect(active.padding).toBe("8px 14px");
    expect(active.borderRadius).toBe("6px 6px 0 0");
    // The active folder tab sits *on* the strip's bottom hairline rather than above it.
    expect(active.marginBottom).toBe("-1px");
  });

  it("keeps the strip out of a scroll container, so the Windows join is not clipped away", () => {
    const strip = renderStyledBar("b.md", "win");
    const stripStyle = getComputedStyle(strip);
    // A scroll container clips its descendants at the *padding* box, and the Windows strip's
    // padding-bottom is 0 — so `overflow-x: auto` (which drags `overflow-y` to `auto` with it,
    // CSS Overflow §3) removes the exact 1px the active tab is pulled past that edge by, leaving
    // `margin-bottom: -1px` inert and the folder tab detached from the canvas it must join.
    expect(stripStyle.overflowX).toBe("visible");
    expect(stripStyle.overflowY).toBe("visible");
    expect(stripStyle.paddingBottom).toBe("0px");
    // Which of the two is clipped away is not only the join: the focus ring's 1px `outline-offset`
    // rides on the same clip.
    expect(getComputedStyle(screen.getByRole("tab", { name: /b\.md/ })).marginBottom).toBe("-1px");
  });

  it("draws macOS pill tabs (platform-variants.md 'Document tabs')", () => {
    const strip = renderStyledBar("b.md", "mac");
    expect(strip).toHaveAttribute("data-platform", "mac");
    expect(getComputedStyle(strip).padding).toBe("8px 12px");
    expect(getComputedStyle(strip).gap).toBe("6px");

    const active = getComputedStyle(screen.getByRole("tab", { name: /b\.md/ }));
    expect(active.padding).toBe("6px 12px");
    expect(active.borderRadius).toBe("7px");
    expect(active.boxShadow).not.toBe("");
  });

  it("distinguishes the active tab from the inactive ones by more than position", () => {
    renderStyledBar("b.md", "win");
    const active = getComputedStyle(screen.getByRole("tab", { name: /b\.md/ }));
    const inactive = getComputedStyle(screen.getByRole("tab", { name: /a\.md/ }));
    // The active tab gains a fill the inactive one has none of, plus its own weight and ink.
    expect(active.backgroundColor).not.toBe(inactive.backgroundColor);
    expect(active.fontWeight).not.toBe(inactive.fontWeight);
    expect(active.color).not.toBe(inactive.color);
  });

  it("labels a tab with its filename, truncated, and keeps the full path as its tooltip", () => {
    const path = "notes/2026/a-filename-long-enough-to-dictate-the-whole-row-width.md";
    renderStyledBar(path, "win", [tab(path)]);

    // Truncating the label must not cost the disambiguation: two same-named documents in different
    // folders still announce (and hover) as their full paths.
    const openTab = screen.getByRole("tab", { name: path });
    expect(openTab).toHaveAttribute("title", path);
    const label = openTab.querySelector(".tab-bar__label");
    expect(label).not.toBeNull();
    expect(label).toHaveTextContent("a-filename-long-enough-to-dictate-the-whole-row-width.md");
    expect(label).not.toHaveTextContent("notes/2026");

    // The label, not the tab, absorbs an over-long name: it ellipsizes inside a bounded tab
    // instead of stretching the strip.
    const labelStyle = getComputedStyle(label as Element);
    expect(labelStyle.overflow).toBe("hidden");
    expect(labelStyle.textOverflow).toBe("ellipsis");
    expect(labelStyle.whiteSpace).toBe("nowrap");
    // The bound itself, not merely "some bound": jsdom reports an unset `max-width` as the initial
    // `none` rather than an empty string, so a `not.toBe("")` cell here could never fail.
    expect(getComputedStyle(openTab).maxWidth).toBe("220px");
  });

  it("renders a Windows-style backslash path's filename too", () => {
    // A project-relative path is normalized to `/` (`stores/menu.ts`), but a path that reached the
    // strip straight from a Windows enumeration is not — and Windows is where #1116 was observed.
    renderStyledBar("notes\\draft.md", "win", [tab("notes\\draft.md")]);
    expect(screen.getByRole("tab").querySelector(".tab-bar__label")).toHaveTextContent("draft.md");
  });

  it("names a recovery document by what it is, not by the filename inside its identity", () => {
    // A displaced document's tab is keyed `untitled:<n>:<displaced path>` (`stores/tabs.ts`), so
    // the filename split this strip applies to project paths would label it `b.md` — indis-
    // tinguishable from the document that took that path, which is the exact confusion the recovery
    // tab exists to prevent (J2, CJ 2026-08-11).
    const label = "Untitled — recovered from drafts/b.md, editable";
    renderStyledBar("untitled:1:drafts/b.md", "win", [
      recoveredTab("untitled:1:drafts/b.md", "drafts/b.md"),
    ]);

    const openTab = screen.getByRole("tab", { name: label });
    expect(openTab).toHaveAttribute("title", label);
    expect(openTab.querySelector(".tab-bar__recovered-qualifier")).toHaveTextContent("UNTITLED");
    expect(openTab.querySelector(".tab-bar__recovered-path")).toHaveTextContent("drafts/b.md");
    expect(openTab.querySelector(".tab-bar__recovery-dot")).toBeNull();
    expect(
      getComputedStyle(openTab.querySelector(".tab-bar__recovered-qualifier") as Element).color,
    ).toBe("var(--color-tab-inactive-fg)");
    expect(
      getComputedStyle(openTab.querySelector(".tab-bar__recovered-path") as Element).fontStyle,
    ).toBe("italic");
    expect(screen.getByRole("button", { name: `Close ${label}` })).toBeInTheDocument();
  });

  it("renders 9c.2's persistent amber indicator and appends the loss fact to the tab name", () => {
    const label =
      "Untitled — recovered from drafts/b.md, editable — earlier unsaved work was not preserved";
    renderStyledBar("untitled:1:drafts/b.md", "win", [
      recoveredTab("untitled:1:drafts/b.md", "drafts/b.md", true),
    ]);

    const openTab = screen.getByRole("tab", { name: label });
    expect(openTab).toHaveAttribute("data-recovery-content-omitted", "true");
    expect(openTab.querySelector(".tab-bar__recovery-dot")).not.toBeNull();
    expect(openTab.querySelector(".tab-bar__recovered-qualifier")).toHaveTextContent("UNTITLED");
    const dotStyle = getComputedStyle(openTab.querySelector(".tab-bar__recovery-dot") as Element);
    expect(dotStyle.width).toBe("6px");
    expect(dotStyle.height).toBe("6px");
    expect(getComputedStyle(document.documentElement).getPropertyValue("--color-recovery-dot").trim()).toBe(
      "#b5871f",
    );
    expect(
      getComputedStyle(openTab.querySelector(".tab-bar__recovered-qualifier") as Element).color,
    ).toBe("var(--color-recovery-fg)");
    expect(getComputedStyle(document.documentElement).getPropertyValue("--color-recovery-fg").trim()).toBe(
      "#8a6614",
    );
    expect(screen.getByRole("button", { name: `Close ${label}` })).toBeInTheDocument();
  });

  function expectOmissionOnlyMarker(platform: TabBarPlatform) {
    const path = "research/survey-export.csv";
    renderStyledBar(path, platform, [{ ...tab(path), recoveryContentOmitted: true }, tab("notes.md")]);

    const openTab = screen.getByRole("tab", {
      name: "research/survey-export.csv — earlier unsaved work was not preserved",
    });
    expect(openTab).toHaveAttribute("data-recovery-content-omitted", "true");
    expect(openTab).toHaveTextContent("survey-export.csv");
    expect(openTab).not.toHaveTextContent("UNTITLED");
    expect(openTab.querySelector(".tab-bar__recovery-dot")).not.toBeNull();
    const dotStyle = getComputedStyle(openTab.querySelector(".tab-bar__recovery-dot") as Element);
    expect(dotStyle.width).toBe("6px");
    expect(dotStyle.height).toBe("6px");
    expect(getComputedStyle(document.documentElement).getPropertyValue("--color-recovery-dot").trim())
      .toBe("#b5871f");
    expect(screen.getByRole("tab", { name: "notes.md" }).querySelector(".tab-bar__recovery-dot"))
      .toBeNull();
  }

  it("marks an omission-only unsupported tab on win without calling it recovered", () => {
    expectOmissionOnlyMarker("win");
  });

  it("marks an omission-only unsupported tab on mac without calling it recovered", () => {
    expectOmissionOnlyMarker("mac");
  });

  it("uses the same stable collision ordinal in the face, accessible name, and close action", () => {
    const first = recoveredTab("untitled:1:drafts/b.md", "drafts/b.md", false, 1);
    const second = recoveredTab("untitled:2:drafts/b.md", "drafts/b.md", false, 2);
    renderStyledBar(first.path, "win", [first, second]);

    const firstName = "Untitled — recovered from drafts/b.md (1), editable";
    const secondName = "Untitled — recovered from drafts/b.md (2), editable";
    expect(screen.getByRole("tab", { name: firstName })).toHaveTextContent("(1)");
    expect(screen.getByRole("tab", { name: secondName })).toHaveTextContent("(2)");
    const ordinal = screen.getByRole("tab", { name: firstName })
      .querySelector(".tab-bar__recovered-ordinal") as Element;
    expect(getComputedStyle(ordinal).color).toBe("var(--color-untitled-footer-fg)");
    expect(getComputedStyle(document.documentElement).getPropertyValue("--color-untitled-footer-fg").trim())
      .toBe("#8c8779");
    expect(screen.getByRole("button", { name: `Close ${firstName}` })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Close ${secondName}` })).toBeInTheDocument();
  });

  it("announces live and composed over-cap states without conflating present work with loss", () => {
    const identity = "untitled:1:drafts/b.md";
    renderStyledBar(identity, "win", [recoveredTab(identity, "drafts/b.md")], new Set([identity]));

    let openTab = screen.getByRole("tab", {
      name: "Untitled — recovered from drafts/b.md, editable — current work is present but not kept in the session",
    });
    expect(openTab).toHaveAttribute("data-live-over-cap", "true");
    expect(openTab.querySelector(".tab-bar__recovery-dot")).not.toBeNull();

    const { unmount } = render(
      <TabBar
        tabs={[recoveredTab("untitled:2:drafts/c.md", "drafts/c.md", true)]}
        activePath="untitled:2:drafts/c.md"
        liveOverCapPaths={new Set(["untitled:2:drafts/c.md"])}
        onSelect={vi.fn()}
        onRequestClose={vi.fn()}
      />,
    );
    openTab = screen.getByRole("tab", {
      name: "Untitled — recovered from drafts/c.md, editable — current work is present but not kept in the session; earlier unsaved work was not preserved",
    });
    expect(openTab.querySelector(".tab-bar__recovery-dot")).not.toBeNull();
    unmount();
  });

  it("names a project document that looks like a recovery identity by its own name", () => {
    // `untitled:1:notes.md` is a legal project path (CJ, 2026-08-12): with no `recoveredFrom` on
    // the record this is an ordinary document, and describing it as recovered — or announcing it
    // as anything but its path — would be the misclassification the flag exists to prevent.
    renderStyledBar("untitled:1:notes.md", "win", [tab("untitled:1:notes.md")]);

    const openTab = screen.getByRole("tab", { name: "untitled:1:notes.md" });
    // The document is at the project root, so its filename *is* the whole name and the face reads
    // it in full. Anchored deliberately: `toHaveTextContent` matches substrings, so an unanchored
    // expectation here passes on almost anything the label could wrongly become.
    expect(openTab.querySelector(".tab-bar__label")).toHaveTextContent(/^untitled:1:notes\.md$/);
    expect(screen.getByRole("button", { name: "Close untitled:1:notes.md" })).toBeInTheDocument();
    expect(openTab).not.toHaveTextContent(/recovered/i);
  });

  it("still splits the filename off a path whose own filename looks like an identity", () => {
    // The other half: the filename split is unchanged for such a document, so it is presented
    // exactly like any other project file — short face, full path announced and on hover.
    renderStyledBar("notes/untitled:1:draft.md", "win", [tab("notes/untitled:1:draft.md")]);

    const openTab = screen.getByRole("tab", { name: "notes/untitled:1:draft.md" });
    expect(openTab.querySelector(".tab-bar__label")).toHaveTextContent(/^untitled:1:draft\.md$/);
    expect(openTab).toHaveAttribute("title", "notes/untitled:1:draft.md");
  });

  it("puts a status dot and a real close icon inside the tab, not Unicode stand-ins", () => {
    const strip = renderStyledBar("a.md", "win", [tab("a.md", true), tab("b.md")]);

    const dirty = screen.getByRole("tab", { name: /a\.md/ });
    expect(dirty.querySelector(".tab-bar__dot")).not.toBeNull();
    expect(screen.getByRole("tab", { name: /b\.md/ }).querySelector(".tab-bar__dot")).toBeNull();

    const close = screen.getByRole("button", { name: "Close a.md" });
    expect(dirty).toContainElement(close);
    expect(close.querySelector("svg")).not.toBeNull();
    // tokens.md: every glyph in the mocks is a stand-in for the codebase's real icon set.
    expect(strip).not.toHaveTextContent(/[×✕✖●•]/);
  });
});
