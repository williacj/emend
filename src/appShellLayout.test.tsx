// @vitest-environment jsdom
// ABOUTME: Pins the authoring center's outer geometry against the shipped stylesheet (#1369,
// ABOUTME: `docs/design/specs/authoring-shell.md` §Layout) — `.editor-region` fills its lane with no
// ABOUTME: outer inset/centering. Its right border (also part of this fix) is pinned in
// ABOUTME: `e2e/acceptance.spec.mjs`'s "P2a-2 walking skeleton" describe block instead — see why below.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The app's real stylesheet, as text — same technique `editor/TabBar.test.tsx` uses (#1116): jsdom
// resolves the cascade for `getComputedStyle` (declared property values) even though it has no
// layout engine, so loading the shipped CSS here keeps `.editor-region`'s own padding/centering —
// the part of this component that *is* the bug — executed rather than asserted by inspection.
//
// The border half of this fix (`border-right: 1px solid var(--color-editor-region-border)`) is
// deliberately NOT pinned here: jsdom's CSSOM doesn't resolve a custom property used inside a
// border *shorthand* — the whole declaration comes back as the unset default (`border-right-width:
// medium`), for both the old and new stylesheet alike, so a jsdom assertion on it can't
// distinguish the fix from the bug it fixes. `TabBar.test.tsx` hits the same limitation and avoids
// it the same way (no border-color assertions there either). The border is pinned for real in
// `e2e/acceptance.spec.mjs`, where a real Chromium resolves the custom property correctly.
const STYLESHEET = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

let styleElement: HTMLStyleElement | null = null;

function renderWithStylesheet(className: string): HTMLElement {
  styleElement = document.createElement("style");
  styleElement.textContent = STYLESHEET;
  document.head.append(styleElement);
  const element = document.createElement("div");
  element.className = className;
  document.body.append(element);
  return element;
}

afterEach(() => {
  styleElement?.remove();
  styleElement = null;
  document.body.replaceChildren();
});

describe("app-shell authoring layout (#1369, specs/authoring-shell.md)", () => {
  it("the document column fills its lane: no outer padding and no child-centering", () => {
    const region = renderWithStylesheet("editor-region");
    const style = getComputedStyle(region);
    expect(style.display).toBe("flex");
    expect(style.flexGrow).toBe("1");
    // The 24px gutter and the centered tab-strip/toolbar/canvas card look are the bug this card
    // fixes — each band keeps its own padding (tab strip/toolbar/canvas), the column adds none.
    expect(style.padding).toBe("0");
    expect(style.alignItems).toBe("normal");
    expect(style.justifyContent).toBe("normal");
    // The scroll behavior long-form authoring (`NI-long-form-authoring-baseline`) depends on is
    // untouched by this card.
    expect(style.overflow).toBe("auto");
  });

  it("keeps the status to one clipped line while its Dismiss control never yields", () => {
    const status = renderWithStylesheet("shell-status");
    const message = document.createElement("p");
    message.className = "shell-status__message";
    const dismiss = document.createElement("button");
    dismiss.className = "shell-status__dismiss";
    status.append(message, dismiss);

    const messageStyle = getComputedStyle(message);
    expect(messageStyle.minWidth).toBe("0px");
    expect(messageStyle.whiteSpace).toBe("nowrap");
    expect(messageStyle.overflow).toBe("hidden");
    expect(messageStyle.textOverflow).toBe("ellipsis");
    expect(getComputedStyle(dismiss).flexShrink).toBe("0");
  });
});
