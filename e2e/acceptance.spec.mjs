// ABOUTME: The e2e walking skeleton (P2a-2, D23, test-plan §4) — the ONE accreting acceptance
// ABOUTME: script. Append new journey assertions as new `test()` blocks in THIS file; future
// ABOUTME: P2a/P2b units build on this suite rather than starting new ad-hoc spec files
// ABOUTME: (test-plan §4: "one script per journey ... accrete").
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  armBatchAddressFault,
  createComment,
  linkChanges,
  loadCommentThreads,
  replyToComment,
} from "./support/commentsDriver.mjs";
import { createCorpusFixtureProject } from "./support/corpusFixture.mjs";
import { proposeChanges } from "./support/deliveryDriver.mjs";
import { createDocument } from "./support/documentBirthDriver.mjs";
import { createFixtureProject } from "./support/fixtureProject.mjs";
import { runFakeAgentScenario } from "./support/fakeAgent.mjs";
import { post } from "./support/testDriverClient.mjs";
import { permissionDriver } from "./support/permissionDriver.mjs";

// CodeMirror resolves its own "Mod-" keybindings (Cmd/Ctrl+S, Cmd/Ctrl+A) against the browser's
// reported platform — Chromium reports the *host* OS even in headless mode, so the modifier this
// e2e run needs to send follows the host, exactly like the app's own keymap module will.
const mod = process.platform === "darwin" ? "Meta" : "Control";
const redo = process.platform === "darwin" ? "Meta+Shift+Z" : "Control+y";

/**
 * Makes the page report a chosen `navigator.platform` before any page script runs. Several modules
 * read it exactly once, at import — `isMac` in `editor/keymap.ts`, and through it UXR-Q7.2's
 * platform-aware save readout, which Windows puts in the status bar and macOS in the title bar
 * (`DocumentSaveStatus`) — so a cell that asserts one platform's presentation has to say so here,
 * or it silently asserts the host's and can only pass on one OS (#2336).
 *
 * **`mod` and `redo` above do not follow this.** They are chosen from the *host* (`process.platform`)
 * because Playwright sends real keys to a real browser, and inside a spoofed cell the two disagree:
 * on a macOS host CodeMirror resolves `Mod-` against the spoofed `Win32` and binds Ctrl, while `mod`
 * is still `Meta`. `${mod}+a` survives that because Chromium's native macOS select-all does the same
 * job, but the next one may not — `${mod}+s` would open Chromium's save dialog instead of reaching
 * the app's own binding. In a spoofed cell, send the modifier the *spoofed* platform implies.
 */
async function reportPlatform(page, navigatorPlatform) {
  await page.addInitScript((reportedPlatform) => {
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: reportedPlatform,
    });
  }, navigatorPlatform);
}

async function openDocument(page, project, path = project.path) {
  await page.evaluate(
    ({ root, documentPath }) => window.__EMEND_E2E__?.openProject(root, documentPath),
    { root: project.root, documentPath: path },
  );
  await expect(page.locator(".cm-content:visible")).toBeVisible();
}

async function chooseTheme(page, mode) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("group", { name: "Theme" }).getByRole("button", { name: mode }).click();
  await dialog.getByRole("button", { name: "Close Settings" }).click();
}

function visibleEditor(page) {
  return page.locator(".cm-content:visible");
}

function visibleScrollHost(page) {
  return page.locator(".editor-shell__host:visible");
}

function messageInput(page) {
  return page.getByRole("textbox", { name: "Message", exact: true });
}

async function projectRailAppearance(rail) {
  return rail.evaluate((element) => {
    const activeRow = element.querySelector(
      '.project-rail__item[aria-current="page"] > .project-rail__row .project-rail__entry',
    );
    const footer = element.querySelector(".project-rail__footer");
    const footerDot = element.querySelector(".project-rail__footer-dot");
    const header = element.querySelector(".project-rail__header");
    const refresh = element.querySelector('[aria-label="Refresh project files"]');
    if (!activeRow || !footer || !footerDot || !header || !refresh) {
      throw new Error("Project rail appearance targets are missing");
    }
    const railStyle = getComputedStyle(element);
    const activeStyle = getComputedStyle(activeRow);
    const footerStyle = getComputedStyle(footer);
    return {
      width: railStyle.width,
      railBackground: railStyle.backgroundColor,
      railForeground: railStyle.color,
      border: railStyle.borderRightColor,
      headerForeground: getComputedStyle(header).color,
      refreshForeground: getComputedStyle(refresh).color,
      activeBackground: activeStyle.backgroundColor,
      activeForeground: activeStyle.color,
      activeShadow: activeStyle.boxShadow,
      footerForeground: footerStyle.color,
      footerBorder: footerStyle.borderTopColor,
      footerPadding: footerStyle.padding,
      footerDot: getComputedStyle(footerDot).backgroundColor,
    };
  });
}

async function scrollMetrics(host) {
  return host.evaluate((element) => ({
    clientHeight: element.clientHeight,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    scrollLeft: element.scrollLeft,
    scrollTop: element.scrollTop,
    scrollWidth: element.scrollWidth,
  }));
}

async function expectLineInsideHost(line, host) {
  // CSS line boxes can cross an integer viewport edge by a fraction of a pixel.
  // A whole hidden line still fails; only raster-rounding slack is accepted.
  const subpixelTolerance = 1;
  let lastBoxes;
  try {
    await expect
      .poll(async () => {
        const [lineBox, hostBox] = await Promise.all([line.boundingBox(), host.boundingBox()]);
        lastBoxes = { lineBox, hostBox };
        if (!lineBox || !hostBox) return false;
        return (
          lineBox.y >= hostBox.y - subpixelTolerance &&
          lineBox.y + lineBox.height <= hostBox.y + hostBox.height + subpixelTolerance &&
          lineBox.x >= hostBox.x - subpixelTolerance &&
          lineBox.x + lineBox.width <= hostBox.x + hostBox.width + subpixelTolerance
        );
      })
      .toBe(true);
  } catch (error) {
    const hostState = await host.evaluate((element) => {
      const caret = element.querySelector(".cm-cursor-primary")?.getBoundingClientRect();
      const selection = window.getSelection();
      const selectedRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const selectedBox = selectedRange?.getBoundingClientRect();
      const selectedLine = selection?.anchorNode?.parentElement?.closest(".cm-line");
      const view = element.querySelector(".cm-content")?.cmTile?.root?.view;
      const lines = element.querySelectorAll(".cm-line");
      return {
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        scrollLeft: element.scrollLeft,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        activeElement: document.activeElement?.outerHTML.slice(0, 220),
        editorFocused: element.contains(document.activeElement),
        caret: caret && { x: caret.x, y: caret.y, width: caret.width, height: caret.height },
        selectedLine: selectedLine?.textContent?.slice(0, 120),
        renderedLineCount: lines.length,
        lastRenderedLine: lines[lines.length - 1]?.textContent?.slice(0, 120),
        editorSelectionHead: view?.state.selection.main.head,
        editorDocumentLength: view?.state.doc.length,
        editorViewport: view && { from: view.viewport.from, to: view.viewport.to },
        documentLastLine: view?.state.doc.line(view.state.doc.lines).text.slice(0, 120),
        editorEndCoords: view?.coordsAtPos(view.state.doc.length),
        editorLastContentLineCoords: view?.coordsAtPos(view.state.doc.length - 1),
        lastRenderedLineBox: lines[lines.length - 1]?.getBoundingClientRect().toJSON(),
        selectionRangeCount: selection?.rangeCount,
        selectionAnchorNode: selection?.anchorNode?.textContent?.slice(0, 120),
        selectionAnchorParent: selection?.anchorNode?.parentElement?.outerHTML.slice(0, 220),
        selectionOffset: selection?.anchorOffset,
        selectedBox: selectedBox && {
          x: selectedBox.x, y: selectedBox.y, width: selectedBox.width, height: selectedBox.height,
        },
      };
    });
    throw new Error(`Document boundary line outside scroll host: ${JSON.stringify({ ...lastBoxes, hostState })}`, {
      cause: error,
    });
  }
}

async function goToDocumentBoundary(page, edge) {
  const editor = visibleEditor(page);
  const host = visibleScrollHost(page);
  await editor.focus();
  await page.keyboard.press(`${mod}+${edge === "start" ? "Home" : "End"}`);
  if (edge === "start") {
    const firstLine = host.locator(".cm-line").first();
    await expect
      .poll(() =>
        host.evaluate((element) => {
          const line = element.querySelector(".cm-line");
          if (!line) return Number.POSITIVE_INFINITY;
          const topInset = Number.parseFloat(getComputedStyle(element).paddingTop);
          const lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight);
          return element.scrollTop / (topInset + lineHeight);
        }),
      )
      .toBeLessThan(1);
    await expectLineInsideHost(firstLine, host);
    return;
  }
  await expect.poll(() => host.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect
    .poll(() =>
      host.evaluate(
        (element) =>
          element.scrollTop >= element.scrollHeight - element.clientHeight * 2,
      ),
    )
    .toBe(true);
  // A source file ending in `\n` gives CM6 a final empty `.cm-line`. Check the last content line
  // and the actual document-end caret: seeing the content alone can hide an offscreen insertion
  // point on that empty boundary line.
  let endCaretMetrics;
  try {
    await expect
      .poll(async () => {
        endCaretMetrics = await host.evaluate((element) => {
          const view = element.querySelector(".cm-content")?.cmTile?.root?.view;
          const caret = view?.coordsAtPos(view.state.doc.length);
          const bounds = element.getBoundingClientRect();
          return {
            head: view?.state.selection.main.head,
            length: view?.state.doc.length,
            caret: caret?.toJSON(),
            bounds: bounds.toJSON(),
            scrollTop: element.scrollTop,
            maximum: element.scrollHeight - element.clientHeight,
            visible: !!view && !!caret && view.state.selection.main.head === view.state.doc.length &&
              caret.top >= bounds.top - 1 && caret.bottom <= bounds.bottom + 1 &&
              caret.left >= bounds.left - 1 && caret.right <= bounds.right + 1,
          };
        });
        return endCaretMetrics.visible;
      })
      .toBe(true);
  } catch (error) {
    throw new Error(`Document-end caret outside scroll host: ${JSON.stringify(endCaretMetrics)}`, {
      cause: error,
    });
  }
  const lastContentLine = host.locator(".cm-line").filter({ hasText: /\S/ }).last();
  await expectLineInsideHost(lastContentLine, host);
}

async function pageDownToFraction(page, targetFraction) {
  const editor = visibleEditor(page);
  const host = visibleScrollHost(page);
  await editor.focus();
  for (let pageCount = 0; pageCount < 500; pageCount += 1) {
    const metrics = await scrollMetrics(host);
    const maximum = metrics.scrollHeight - metrics.clientHeight;
    if (maximum > 0 && metrics.scrollTop >= maximum * targetFraction) return;
    await page.keyboard.press("PageDown");
  }
  throw new Error(`The document did not reach ${targetFraction * 100}% through PageDown input`);
}

async function clickViewportCenterLine(host) {
  const box = await host.boundingBox();
  expect(box).not.toBeNull();
  await host.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await host.locator(".cm-content").press("Home");
}

test.describe("A2 approved window chrome", () => {
  async function checkTitleRow(page, platform, navigatorPlatform, height) {
    const project = createFixtureProject("# Window title\n");
    try {
      await reportPlatform(page, navigatorPlatform);
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto("/");
      const header = page.locator(".app-header");
      await expect(header).toBeVisible();
      await expect(header).toHaveAttribute("data-platform", platform);
      await expect(header).toContainText("Emend");
      await expect.poll(() => header.evaluate((element) => element.getBoundingClientRect().height)).toBe(height);
      const welcomeTop = await page.locator(".welcome-screen").evaluate((element) => element.getBoundingClientRect().top);
      const headerBottom = await header.evaluate((element) => element.getBoundingClientRect().bottom);
      expect(welcomeTop).toBeGreaterThanOrEqual(headerBottom);
      if (platform === "win") {
        await expect(header.getByRole("group", { name: "Window controls" })).toBeVisible();
        await expect(header.getByRole("button", { name: "Close window" })).toBeVisible();
      } else {
        await expect(header.locator(".app-header__traffic-light-space")).toHaveCSS("width", "72px");
        await expect(header.getByRole("button", { name: "Close window" })).toHaveCount(0);
      }

      await openDocument(page, project);
      await expect(header).toHaveCount(1);
      await expect(header.locator(".app-header__title")).toContainText("notes.md");
      await expect.poll(() => header.evaluate((element) => element.getBoundingClientRect().height)).toBe(height);
    } finally {
      await project.cleanup(page);
    }
  }

  test("Windows keeps one 38px title row across welcome and authoring", async ({ page }) => {
    await checkTitleRow(page, "win", "Win32", 38);
  });

  test("macOS keeps one 44px overlay row across welcome and authoring", async ({ page }) => {
    await checkTitleRow(page, "mac", "MacIntel", 44);
  });

  async function checkFallbackTitleRow(page, platform, navigatorPlatform, height) {
    await reportPlatform(page, navigatorPlatform);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    const runtimeError = page.waitForEvent("pageerror");
    await page.evaluate(() => window.__EMEND_E2E__?.triggerRenderFailure());
    await runtimeError;
    const fallback = page.getByRole("main", { name: "Emend can’t show this window right now." });
    await expect(fallback).toBeVisible();
    const button = fallback.getByRole("button", { name: "Reload window" });
    const restingHeight = await button.evaluate((element) => element.getBoundingClientRect().height);
    const pendingHeight = await button.evaluate((element) => {
      element.setAttribute("aria-disabled", "true");
      const height = element.getBoundingClientRect().height;
      element.removeAttribute("aria-disabled");
      return height;
    });
    expect(pendingHeight).toBe(restingHeight);
    const header = page.locator(".app-header");
    await expect(header).toHaveCount(1);
    await expect.poll(() => header.evaluate((element) => element.getBoundingClientRect().height)).toBe(height);
    await expect(header).toHaveAttribute("data-platform", platform);
    await expect(page.locator(".app-body, .project-rail, .timeline-panel")).toHaveCount(0);
    if (platform === "win") {
      await expect(header.getByRole("button", { name: "Close window" })).toBeVisible();
      await expect(header.locator(".app-header__title")).toHaveText("Emend");
    } else {
      await expect(header.getByRole("button", { name: "Close window" })).toHaveCount(0);
      await expect(header.locator(".app-header__traffic-light-space")).toHaveCSS("width", "72px");
      await expect(header.locator(".app-header__title")).toBeEmpty();
    }
  }

  test("win render fallback retains only the platform title row", async ({ page }) => {
    await checkFallbackTitleRow(page, "win", "Win32", 38);
  });

  test("mac render fallback retains only the platform title row", async ({ page }) => {
    await checkFallbackTitleRow(page, "mac", "MacIntel", 44);
  });
});

test.describe("C3 composer", () => {
  let project;

  test.afterEach(async ({ page }) => {
    await project.cleanup(page);
  });

  test("C3 composer Windows uses the warm pinned input row with honest controls", async ({ page }) => {
    await reportPlatform(page, "Win32");
    project = createFixtureProject("# Composer\n\nHello world.\n");
    await page.goto("/");
    await openDocument(page, project);
    const composer = page.locator(".message-composer");
    const field = page.getByRole("textbox", { name: "Message" });
    await expect(field).toHaveAttribute("placeholder", "Message…");
    await expect(composer.getByRole("button", { name: "Dictate — unavailable in this build" })).toBeDisabled();
    await expect(composer.getByRole("button", { name: "Send" })).toBeEnabled();
    const appearance = await composer.evaluate((element) => {
      const panel = element.closest(".timeline-panel");
      const row = element.querySelector(".message-input");
      const input = element.querySelector(".message-input__field");
      const send = element.querySelector(".message-input__send");
      const mic = element.querySelector(".dictation-mic");
      const style = getComputedStyle(element);
      const inputStyle = getComputedStyle(input);
      const sendStyle = getComputedStyle(send);
      const fieldBounds = input.getBoundingClientRect();
      const micBounds = mic.getBoundingClientRect();
      const sendBounds = send.getBoundingClientRect();
      return {
        panelBottom: panel.getBoundingClientRect().bottom,
        composerBottom: element.getBoundingClientRect().bottom,
        background: style.backgroundColor,
        border: style.borderTopColor,
        padding: style.padding,
        gap: style.rowGap,
        rowGap: getComputedStyle(row).columnGap,
        fieldHeight: input.getBoundingClientRect().height,
        fieldPadding: inputStyle.padding,
        fieldRadius: inputStyle.borderTopLeftRadius,
        fieldBackground: inputStyle.backgroundColor,
        sendHeight: send.getBoundingClientRect().height,
        sendRadius: sendStyle.borderTopLeftRadius,
        sendBackground: sendStyle.backgroundColor,
        sendForeground: sendStyle.color,
        micSize: [mic.getBoundingClientRect().width, mic.getBoundingClientRect().height],
        micInsideInput: micBounds.left >= fieldBounds.left && micBounds.right <= fieldBounds.right &&
          micBounds.top >= fieldBounds.top && micBounds.bottom <= fieldBounds.bottom,
        sendRightOfInput: sendBounds.left > fieldBounds.right,
      };
    });
    expect(appearance).toEqual({
      panelBottom: appearance.composerBottom,
      composerBottom: appearance.composerBottom,
      background: "rgb(240, 237, 230)",
      border: "rgb(227, 223, 214)",
      padding: "12px 14px 14px",
      gap: "9px",
      rowGap: "8px",
      fieldHeight: 38,
      fieldPadding: "10px 44px 10px 12px",
      fieldRadius: "8px",
      fieldBackground: "rgb(255, 255, 255)",
      sendHeight: 36,
      sendRadius: "8px",
      sendBackground: "rgb(31, 29, 26)",
      sendForeground: "rgb(255, 255, 255)",
      micSize: [28, 26],
      micInsideInput: true,
      sendRightOfInput: true,
    });
  });

  test("C3 composer macOS uses inset controls and the warm rail fill", async ({ page }) => {
    await reportPlatform(page, "MacIntel");
    project = createFixtureProject("# Composer\n\nHello world.\n");
    await page.goto("/");
    await openDocument(page, project);
    const composer = page.locator(".message-composer");
    const field = page.getByRole("textbox", { name: "Message" });
    await expect(composer.getByRole("button", { name: "Dictate — unavailable in this build" })).toBeDisabled();
    const appearance = await composer.evaluate((element) => {
      const field = element.querySelector(".message-input__field");
      const mic = element.querySelector(".dictation-mic");
      const send = element.querySelector(".message-input__send");
      const fieldBounds = field.getBoundingClientRect();
      const micBounds = mic.getBoundingClientRect();
      return {
        background: getComputedStyle(element).backgroundColor,
        fieldBorder: getComputedStyle(field).borderTopWidth,
        fieldRadius: getComputedStyle(field).borderTopLeftRadius,
        fieldShadow: getComputedStyle(field).boxShadow,
        micShadow: getComputedStyle(mic).boxShadow,
        sendRadius: getComputedStyle(send).borderTopLeftRadius,
        micInsideInput: micBounds.left >= fieldBounds.left && micBounds.right <= fieldBounds.right &&
          micBounds.top >= fieldBounds.top && micBounds.bottom <= fieldBounds.bottom,
        sendRightOfInput: send.getBoundingClientRect().left > fieldBounds.right,
      };
    });
    expect(appearance).toEqual({
      background: "rgb(237, 234, 226)",
      fieldBorder: "0px",
      fieldRadius: "9px",
      fieldShadow: "rgb(220, 215, 204) 0px 0px 0px 1px",
      micShadow: "rgb(227, 223, 214) 0px 0px 0px 1px",
      sendRadius: "9px",
      micInsideInput: true,
      sendRightOfInput: true,
    });
    await field.fill("A short workshop thought.");
    await field.press("Enter");
    await expect(page.getByText("A short workshop thought.")).toBeVisible();
  });

  test("dark dictation phase chips keep their distinct treatments", async ({ page }) => {
    await reportPlatform(page, "Win32");
    project = createFixtureProject("# Composer\n\nHello world.\n");
    await page.goto("/");
    await openDocument(page, project);
    const colours = await page.locator(".message-input .dictation-mic").evaluate((mic) => {
      document.documentElement.dataset.theme = "dark";
      const read = (kind) => {
        mic.className = `dictation-mic dictation-mic--${kind}`;
        const style = getComputedStyle(mic);
        return { background: style.backgroundColor, foreground: style.color };
      };
      return { recording: read("recording"), transcribing: read("transcribing"), error: read("error") };
    });
    expect(colours).toEqual({
      recording: { background: "rgb(230, 231, 234)", foreground: "rgb(30, 31, 34)" },
      transcribing: { background: "rgb(38, 40, 44)", foreground: "rgb(230, 231, 234)" },
      error: { background: "rgb(38, 40, 44)", foreground: "rgb(248, 113, 113)" },
    });
  });

  test("C3 composer quoted selection uses the Windows inset quote bar and dismisses", async ({ page }) => {
    await reportPlatform(page, "Win32");
    project = createFixtureProject("Hello brave world.\n");
    await page.goto("/");
    await openDocument(page, project);
    await page.locator(".cm-line").first().click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i += 1) await page.keyboard.press("Shift+ArrowRight");
    await page.getByRole("button", { name: "Quote to chat" }).click();
    const quote = page.getByRole("note", { name: "Quoted selection" });
    await expect(quote).toContainText("“Hello”");
    const appearance = await quote.evaluate((element) => {
      const style = getComputedStyle(element);
      const text = getComputedStyle(element.querySelector(".quote-bar__text"));
      const dismiss = getComputedStyle(element.querySelector(".quote-bar__dismiss"));
      return {
        background: style.backgroundColor,
        leftRule: [style.borderLeftWidth, style.borderLeftColor],
        radius: style.borderRadius,
        padding: style.padding,
        textFont: text.fontFamily,
        textSize: text.fontSize,
        textColor: text.color,
        dismissColor: dismiss.color,
      };
    });
    expect(appearance).toEqual({
      background: "rgb(232, 228, 219)",
      leftRule: ["3px", "rgb(184, 179, 168)"],
      radius: "0px 6px 6px 0px",
      padding: "7px 10px",
      textFont: '"Source Serif 4", Georgia, serif',
      textSize: "12.5px",
      textColor: "rgb(74, 70, 62)",
      dismissColor: "rgb(140, 135, 121)",
    });
    await quote.getByRole("button", { name: "Remove quote" }).click();
    await expect(quote).toHaveCount(0);
  });

  test("C3 composer macOS quoted selection keeps the inset fill and visible keyboard focus", async ({ page }) => {
    await reportPlatform(page, "MacIntel");
    project = createFixtureProject("Hello brave world.\n");
    await page.goto("/");
    await openDocument(page, project);
    await page.locator(".cm-line").first().click({ position: { x: 1, y: 1 } });
    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i += 1) await page.keyboard.press("Shift+ArrowRight");
    await page.getByRole("button", { name: "Quote to chat" }).click();
    const quote = page.getByRole("note", { name: "Quoted selection" });
    await expect(quote).toContainText("“Hello”");
    expect(await quote.evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      radius: getComputedStyle(element).borderRadius,
    }))).toEqual({ background: "rgb(227, 223, 214)", radius: "0px 7px 7px 0px" });
    await page.keyboard.press("Tab");
    const dismiss = quote.getByRole("button", { name: "Remove quote" });
    await dismiss.focus();
    expect(await dismiss.evaluate((element) => ({
      width: getComputedStyle(element).outlineWidth,
      color: getComputedStyle(element).outlineColor,
    }))).toEqual({ width: "2px", color: "rgb(79, 70, 229)" });
    const field = page.getByRole("textbox", { name: "Message" });
    await field.focus();
    expect(await field.evaluate((element) => ({
      width: getComputedStyle(element).outlineWidth,
      color: getComputedStyle(element).outlineColor,
    }))).toEqual({ width: "2px", color: "rgb(79, 70, 229)" });
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    const send = page.getByRole("button", { name: "Send" });
    for (const control of [dismiss, field, send]) {
      await control.focus();
      await expect(control).toHaveCSS("outline-color", "rgb(165, 176, 255)");
    }
  });
});

test.describe("D5 existing welcome composition", () => {
  async function checkWelcome(page, platform, navigatorPlatform) {
    await reportPlatform(page, navigatorPlatform);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    const welcome = page.locator(".welcome-screen");
    await expect(welcome).toBeVisible();
    await expect(welcome).toHaveCSS("max-width", "520px");
    const heading = welcome.getByRole("heading", { name: "Welcome to Emend" });
    await expect(heading).toHaveCSS("font-family", /Source Serif 4/);
    await expect(heading).toHaveCSS("font-size", "27px");
    const open = welcome.getByRole("button", { name: "Open a folder…" });
    await expect(open).toHaveCSS("background-color", "rgb(31, 29, 26)");
    await expect(open).toHaveCSS("border-radius", platform === "mac" ? "7px" : "6px");
    await expect(welcome.getByRole("heading", { name: "Recent" })).toHaveCSS("text-transform", "uppercase");
    await expect(welcome.getByRole("region", { name: "Writing partners" })).toHaveCSS("background-color", "rgb(250, 248, 243)");
    await expect(welcome.getByRole("region", { name: "Writing partners" }).locator(".provider-chip")).toHaveCount(2);
    // The driver reports no installed providers. Exercise the existing signed-out CSS
    // state on a real rendered chip; ProviderChip's component test covers its state mapping.
    const signedOutStyle = await welcome.locator(".provider-chip").first().evaluate((chip) => {
      chip.setAttribute("data-state", "installed_signed_out");
      const dot = chip.querySelector(".provider-chip__dot");
      const label = chip.querySelector(".provider-chip__label");
      const dotStyle = getComputedStyle(dot);
      return {
        labelColor: getComputedStyle(label).color,
        dotColor: dotStyle.backgroundColor,
        dotWidth: dotStyle.width,
        dotHeight: dotStyle.height,
        dotRadius: dotStyle.borderRadius,
      };
    });
    expect(signedOutStyle).toEqual({
      labelColor: "rgb(107, 102, 92)",
      dotColor: "rgb(189, 184, 172)",
      dotWidth: "6px",
      dotHeight: "6px",
      dotRadius: "50%",
    });
    await expect(welcome.getByRole("button", { name: "Connect now" })).toBeDisabled();
    const geometry = await welcome.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const parent = element.parentElement?.getBoundingClientRect();
      return { width: rect.width, left: rect.left, parentWidth: parent?.width ?? 0 };
    });
    expect(geometry.width).toBe(520);
    expect(Math.abs(geometry.left - (geometry.parentWidth - geometry.width) / 2)).toBeLessThan(3);
  }

  test("Windows welcome uses the warm 520px entry composition", async ({ page }) => {
    await checkWelcome(page, "win", "Win32");
  });
  test("macOS welcome uses the warm 520px entry composition", async ({ page }) => {
    await checkWelcome(page, "mac", "MacIntel");
  });
});

test.describe("B5 existing document projection", () => {
  async function checkRedlineInk(page, navigatorPlatform) {
    const project = createFixtureProject("Hello {--old--}{++new++} world\n");
    try {
      await reportPlatform(page, navigatorPlatform);
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto("/");
      await openDocument(page, project);
      const insertion = page.locator(".cm-redlineInsert");
      const deletion = page.locator(".cm-redlineDelete");
      await expect(insertion).toHaveText("new");
      await expect(deletion).toHaveText("old");
      await expect(insertion).toHaveCSS("color", "rgb(34, 82, 47)");
      await expect(insertion).toHaveCSS("background-color", "rgb(237, 244, 239)");
      await expect(insertion).toHaveCSS("border-bottom-color", "rgb(46, 107, 68)");
      await expect(deletion).toHaveCSS("color", "rgb(163, 58, 46)");
      await expect(deletion).toHaveCSS("text-decoration-line", "line-through");
    } finally {
      await project.cleanup(page);
    }
  }

  async function checkSelectionActions(page, platform, navigatorPlatform) {
    const project = createFixtureProject("Hello world\n");
    try {
      await reportPlatform(page, navigatorPlatform);
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto("/");
      await openDocument(page, project);
      await page.locator(".cm-content").click();
      await page.keyboard.press(platform === "mac" ? "Meta+Home" : "Control+Home");
      for (let index = 0; index < 5; index += 1) await page.keyboard.press("Shift+ArrowRight");
      const actions = page.locator(".editor-shell__selection-affordances");
      await expect(actions).toBeVisible();
      await expect(actions.getByRole("button")).toHaveText(["Comment", "Quote to chat"]);
      await expect(actions.getByRole("button", { name: "Comment" })).toHaveCSS("background-color", "rgb(240, 237, 230)");
      await expect(actions).toHaveCSS("font-size", "12.5px");
      await expect(actions).toHaveCSS("background-color", platform === "mac" ? "rgba(252, 251, 248, 0.92)" : "rgb(255, 255, 255)");
      await actions.getByRole("button", { name: "Quote to chat" }).click();
      await expect(page.getByLabel("Quoted selection")).toContainText("Hello");
    } finally {
      await project.cleanup(page);
    }
  }

  async function checkParagraphRedline(page, navigatorPlatform) {
    const project = createFixtureProject("{++A whole paragraph.++}\n\nAnother {++small++} change.\n");
    try {
      await reportPlatform(page, navigatorPlatform);
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto("/");
      await openDocument(page, project);
      const block = page.locator(".cm-redlineParagraph");
      await expect(block).toHaveCount(1);
      await expect(block).toContainText("A whole paragraph.");
      await expect(block).toHaveCSS("border-left-color", "rgb(181, 135, 31)");
      await expect(block).toHaveCSS("border-left-width", "3px");
      await expect(block).toHaveCSS("padding-left", "14px");
      await expect(block).toHaveCSS("color", "rgb(51, 48, 42)");
      await expect(block.locator(".cm-redlineInsert, .cm-redlineDelete")).toHaveCount(0);
      await expect(page.locator(".cm-redlineInsert")).toHaveText("small");
      await page.setViewportSize({ width: 660, height: 900 });
      await expect(block).toHaveCount(1);
      const toolbar = page.locator(".view-mode-toolbar:visible");
      const viewSlot = toolbar.locator('[data-toolbar-control="editor-view"]');
      await expect(viewSlot).toHaveAttribute("data-overflowed", "true");
      const activateView = async (name) => {
        if (await viewSlot.getAttribute("data-overflowed") === "true") {
          await toolbar.getByRole("button", { name: "More editor controls" }).click();
          await page.getByRole("dialog", { name: "More editor controls" }).getByRole("button", { name }).click();
          return;
        }
        await toolbar.getByRole("button", { name }).click();
      };
      await activateView("Markdown");
      await expect(block).toHaveCount(0);
      await activateView("Rich text");
      await expect(block).toHaveCount(1);
    } finally {
      await project.cleanup(page);
    }
  }

  test("win keeps a whole-paragraph change on its own amber inset line", async ({ page }) => {
    await checkParagraphRedline(page, "Win32");
  });
  test("mac keeps a whole-paragraph change on its own amber inset line", async ({ page }) => {
    await checkParagraphRedline(page, "MacIntel");
  });

  test("win uses the designed insertion and deletion ink", async ({ page }) => {
    await checkRedlineInk(page, "Win32");
  });
  test("mac uses the designed insertion and deletion ink", async ({ page }) => {
    await checkRedlineInk(page, "MacIntel");
  });
  test("win groups the existing selection actions in mock order", async ({ page }) => {
    await checkSelectionActions(page, "win", "Win32");
  });
  test("mac groups the existing selection actions in mock order", async ({ page }) => {
    await checkSelectionActions(page, "mac", "MacIntel");
  });
});

test.describe("B4a existing toolbar view controls", () => {
  async function checkViewControls(page, platform, navigatorPlatform) {
    const project = createFixtureProject("# Toolbar\n\nBody text.\n");
    try {
      await reportPlatform(page, navigatorPlatform);
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto("/");
      await openDocument(page, project);
      const toolbar = page.getByRole("toolbar", { name: "Editor view controls" });
      await expect(toolbar).toHaveAttribute("data-platform", platform);
      const track = toolbar.getByRole("group", { name: "Editor view" });
      const rich = track.getByRole("button", { name: "Rich text" });
      const markdown = track.getByRole("button", { name: "Markdown" });
      await expect(rich).toHaveAttribute("aria-pressed", "true");
      await expect(toolbar.getByRole("group", { name: "Review changes" })).toHaveCount(0);
      if (platform === "win") {
        await expect(track).toHaveCSS("background-color", "rgb(255, 255, 255)");
        await expect(rich).toHaveCSS("background-color", "rgb(31, 29, 26)");
        await expect(rich).toHaveCSS("color", "rgb(255, 255, 255)");
      } else {
        await expect(track).toHaveCSS("background-color", "rgb(232, 228, 219)");
        await expect(rich).toHaveCSS("background-color", "rgb(255, 255, 255)");
        await expect(rich).toHaveCSS("color", "rgb(31, 29, 26)");
      }
      for (const [name, width] of [["Bold", 27], ["Italic", 27], ["Heading 1", 31], ["Bulleted list", 31]]) {
        const button = toolbar.getByRole("button", { name });
        await expect(button).toHaveCSS("width", `${width}px`);
        await expect(button).toHaveCSS("height", "26px");
      }
      await markdown.click();
      await expect(markdown).toHaveAttribute("aria-pressed", "true");
      await expect(rich).toHaveAttribute("aria-pressed", "false");
      const bounds = await toolbar.evaluate((element) => {
        const buttons = [...element.querySelectorAll("button")];
        return {
          height: element.getBoundingClientRect().height,
          buttonTops: buttons.map((button) => button.getBoundingClientRect().top),
        };
      });
      expect(bounds.height).toBeLessThan(48);
      expect(Math.max(...bounds.buttonTops) - Math.min(...bounds.buttonTops)).toBeLessThan(4);
    } finally {
      await project.cleanup(page);
    }
  }

  test("Windows uses the bordered ink-active segmented control", async ({ page }) => {
    await checkViewControls(page, "win", "Win32");
  });

  test("macOS uses the warm inset track and white active pill", async ({ page }) => {
    await checkViewControls(page, "mac", "MacIntel");
  });
});

test.describe("B4a existing redline context", () => {
  async function checkRedlineContext(page, platform, navigatorPlatform) {
    const project = createFixtureProject("Hello {++brave ++}world\n");
    try {
      await reportPlatform(page, navigatorPlatform);
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto("/");
      await openDocument(page, project);
      const toolbar = page.getByRole("toolbar", { name: "Editor view controls" });
      const review = toolbar.getByRole("group", { name: "Review changes" });
      await expect(review).toContainText("1 of 1");
      const accept = review.getByRole("button", { name: "✓ Accept" });
      const reject = review.getByRole("button", { name: "✗ Reject" });
      await expect(accept).toHaveCSS("background-color", "rgb(237, 244, 239)");
      await expect(accept).toHaveCSS("color", "rgb(46, 107, 68)");
      await expect(reject).toHaveCSS("background-color", "rgb(248, 239, 237)");
      await expect(reject).toHaveCSS("color", "rgb(163, 58, 46)");
      const stepper = review.locator(".redline-toolbar__stepper");
      const previous = stepper.getByRole("button", { name: "Previous change" });
      const next = stepper.getByRole("button", { name: "Next change" });
      const count = stepper.locator(".redline-toolbar__count");
      await expect(stepper).toBeVisible();
      await expect(previous).toHaveText("‹");
      await expect(next).toHaveText("›");
      await expect(previous).toHaveCSS("color", "rgb(107, 102, 92)");
      if (platform === "mac") {
        await expect(previous).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        await expect(count).toHaveCSS("background-color", "rgb(255, 255, 255)");
      } else {
        await expect(count).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      }
      await expect(review.locator(".track-changes-bulk-menu > summary")).toContainText("Bulk");
      if (platform === "mac") {
        await expect(accept.locator(".redline-toolbar__accept-shortcut")).toBeVisible();
      } else {
        await expect(accept.locator(".redline-toolbar__accept-shortcut")).toBeHidden();
      }
      await accept.click();
      await expect(review).toHaveCount(0);
    } finally {
      await project.cleanup(page);
    }
  }

  test("Windows draws its existing change controls as one grouped context", async ({ page }) => {
    await checkRedlineContext(page, "win", "Win32");
  });

  test("macOS draws the same controls with its shortcut hint", async ({ page }) => {
    await checkRedlineContext(page, "mac", "MacIntel");
  });
});

async function checkWorkshopMeasure(page, navigatorPlatform) {
  const project = createFixtureProject("# Workshop source\n");
  try {
    await reportPlatform(page, navigatorPlatform);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);
    await expect(page.locator(".app-body")).toHaveClass(/app-body--workshop/);
    const measure = async () => page.locator(".timeline-panel").evaluate((panel) => {
      const lane = panel.getBoundingClientRect();
      const stream = panel.querySelector(".timeline-panel__stream").getBoundingClientRect();
      const composer = panel.querySelector(".message-composer").getBoundingClientRect();
      return {
        laneWidth: lane.width,
        streamWidth: stream.width,
        composerWidth: composer.width,
        streamOffset: stream.left - lane.left,
        composerOffset: composer.left - lane.left,
      };
    });
    const wide = await measure();
    expect(wide.laneWidth).toBe(1164);
    expect(wide.streamWidth).toBe(720);
    expect(wide.composerWidth).toBe(720);
    expect(Math.abs(wide.streamOffset - (wide.laneWidth - 720) / 2)).toBeLessThan(2);
    expect(Math.abs(wide.composerOffset - wide.streamOffset)).toBeLessThan(2);
    await page.setViewportSize({ width: 660, height: 700 });
    const narrow = await measure();
    expect(narrow.streamWidth).toBe(narrow.laneWidth);
    expect(narrow.composerWidth).toBe(narrow.laneWidth);
    await page.getByRole("textbox", { name: "Message" }).fill("A workshop thought");
    await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue("A workshop thought");
  } finally {
    await project.cleanup(page);
  }
}

test("C1b Windows workshop conversation keeps the 10c center-stage measure", async ({ page }) => {
  await checkWorkshopMeasure(page, "Win32");
});

test("C1b macOS workshop conversation keeps the 10c center-stage measure", async ({ page }) => {
  await checkWorkshopMeasure(page, "MacIntel");
});

test.describe("C4 existing comment card", () => {
  async function checkOpenCard(page, platform, expected) {
      const content = "A paragraph with a selected phrase for a comment.\n";
      const project = createFixtureProject(content);
      try {
        await createComment(
          project.root,
          project.path,
          "alice",
          "Please clarify this passage.",
          {
            content,
            utf16Offset: content.indexOf("selected phrase"),
            utf16Length: "selected phrase".length,
          },
          0,
        );
        await reportPlatform(page, platform);
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.goto("/");
        await openDocument(page, project);
        await page.locator(".cm-commentHighlight").click();
        const popover = page.getByRole("dialog", { name: "Comment thread" });
        const card = popover.locator('[data-card-kind="comment"]');
        await expect(card).toContainText("Please clarify this passage.");
        const appearance = await popover.evaluate((element) => {
          const card = element.querySelector('[data-card-kind="comment"]');
          const body = card.querySelector(".comment-thread-card__body");
          const cardStyle = getComputedStyle(card);
          const bodyStyle = getComputedStyle(body);
          return {
            popoverWidth: element.getBoundingClientRect().width,
            platform: element.getAttribute("data-platform"),
            cardPadding: cardStyle.padding,
            cardRadius: cardStyle.borderRadius,
            cardBorder: cardStyle.borderLeftWidth,
            cardBackground: cardStyle.backgroundColor,
            bodySize: bodyStyle.fontSize,
            bodyLineHeight: bodyStyle.lineHeight,
            bodyColor: bodyStyle.color,
          };
        });
        expect(appearance).toEqual({
          popoverWidth: 340,
          platform: platform === "Win32" ? "win" : "mac",
          cardPadding: "13px",
          cardRadius: expected.radius,
          cardBorder: expected.border,
          cardBackground: "rgb(255, 255, 255)",
          bodySize: "13px",
          bodyLineHeight: "20.8px",
          bodyColor: "rgb(51, 48, 42)",
        });
        expect(await popover.locator(".comment-thread-card__header").evaluate((header) => {
          const avatar = header.querySelector(".comment-thread-card__avatar");
          const author = header.querySelector(".comment-thread-card__author");
          const resolve = header.querySelector(".comment-thread-card__resolve");
          return {
            gap: getComputedStyle(header).gap,
            avatarSize: avatar.getBoundingClientRect().width,
            avatarRadius: getComputedStyle(avatar).borderRadius,
            authorSize: getComputedStyle(author).fontSize,
            authorWeight: getComputedStyle(author).fontWeight,
            resolveAtRight: resolve.getBoundingClientRect().right > author.getBoundingClientRect().right,
          };
        })).toEqual({
          gap: "9px",
          avatarSize: 26,
          avatarRadius: "50%",
          authorSize: "12.5px",
          authorWeight: "500",
          resolveAtRight: true,
        });
        await expect(popover.getByRole("button", { name: "Resolve" })).toBeVisible();
        await expect(page.locator(".cm-commentHighlight-selected")).toHaveCount(1);
        await expect(popover.locator(".comment-thread-card__replies")).toHaveCount(0);
        const replyField = popover.getByRole("textbox", { name: "Reply to alice's comment" });
        const replyButton = popover.getByRole("button", { name: "Reply", exact: true });
        await expect(replyField).toHaveAttribute("placeholder", "Reply…");
        await expect(replyButton).toBeHidden();
        expect(await replyField.evaluate((element) => {
          const style = getComputedStyle(element);
          return {
            padding: style.padding,
            radius: style.borderRadius,
            size: style.fontSize,
            background: style.backgroundColor,
          };
        })).toEqual({
          padding: "9px 11px",
          radius: platform === "Win32" ? "7px" : "8px",
          size: "12.5px",
          background: platform === "Win32" ? "rgb(252, 251, 248)" : "rgb(250, 248, 243)",
        });
        await replyField.focus();
        await expect(replyButton).toBeVisible();
        await popover.getByRole("button", { name: "Resolve" }).click();
        await popover.getByRole("button", { name: /^Expand/ }).click();
        await expect(page.locator(".cm-commentHighlight-resolved")).toHaveCount(1);
        // comments.md: Selected composes with every state. The still-selected resolved anchor takes
        // the selected fill and keeps Resolved's 1px dashed line, darkened for the selected fill.
        const selectedResolved = page.locator(".cm-commentHighlight-resolved.cm-commentHighlight-selected");
        await expect(selectedResolved).toHaveCount(1);
        await expect(selectedResolved).toHaveCSS("background-color", "rgb(225, 224, 248)");
        await expect(selectedResolved).toHaveCSS("border-bottom", "1px dashed rgb(107, 102, 92)");
        await expect(popover.getByRole("textbox", { name: "Reply to alice's comment" })).toHaveCount(0);
        await expect(card.locator('.comment-thread-card__state[data-thread-state="resolved"] .lucide-check')).toBeVisible();
        const resolved = await card.evaluate((element) => {
          const style = getComputedStyle(element);
          const bodyStyle = getComputedStyle(element.querySelector(".comment-thread-card__body"));
          return {
            background: style.backgroundColor,
            borderStyle: style.borderTopStyle,
            borderWidth: style.borderTopWidth,
            padding: style.padding,
            bodySize: bodyStyle.fontSize,
            bodyColor: bodyStyle.color,
          };
        });
        expect(resolved).toEqual({
          background: platform === "Win32" ? "rgb(247, 245, 239)" : "rgb(245, 243, 237)",
          borderStyle: platform === "Win32" ? "dashed" : "none",
          borderWidth: platform === "Win32" ? "1px" : "0px",
          padding: "12px 13px",
          bodySize: "12.5px",
          bodyColor: "rgb(140, 135, 121)",
        });
      } finally {
        await project.cleanup(page);
      }
  }

  test("C4 existing comment popover matches the open-card fragment on Win32", async ({ page }) => {
    await checkOpenCard(page, "Win32", { radius: "8px", border: "1px" });
  });

  test("C4 existing comment popover matches the open-card fragment on MacIntel", async ({ page }) => {
    await checkOpenCard(page, "MacIntel", { radius: "10px", border: "0px" });
  });

  test("C4 keyboard resolve moves focus to Expand and Reopen restores the open anchor", async ({ page }) => {
    const content = "A paragraph with a selected phrase for a comment.\n";
    const project = createFixtureProject(content);
    try {
      await createComment(project.root, project.path, "alice", "Please clarify this passage.", {
        content,
        utf16Offset: content.indexOf("selected phrase"),
        utf16Length: "selected phrase".length,
      }, 0);
      await reportPlatform(page, "MacIntel");
      await page.goto("/");
      await openDocument(page, project);
      await page.locator(".cm-commentHighlight").click();
      const popover = page.getByRole("dialog", { name: "Comment thread" });
      const resolve = popover.getByRole("button", { name: "Resolve" });
      await resolve.focus();
      await page.keyboard.press("Enter");
      const expand = popover.getByRole("button", { name: /^Expand/ });
      await expect(expand).toBeFocused();
      await expect(page.locator(".cm-commentHighlight-resolved")).toHaveCount(1);
      await page.keyboard.press("Enter");
      const reopen = popover.getByRole("button", { name: "Reopen" });
      await expect(reopen).toBeVisible();
      await reopen.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator(".cm-commentHighlight-open")).toHaveCount(1);
      await expect(page.locator(".cm-commentHighlight-resolved")).toHaveCount(0);
    } finally {
      await project.cleanup(page);
    }
  });

  test("C4 dark comment controls use theme accent and surface", async ({ page }) => {
    const content = "A paragraph with a selected phrase for a comment.\n";
    const project = createFixtureProject(content);
    try {
      const created = await createComment(project.root, project.path, "alice", "Please clarify this passage.", {
        content,
        utf16Offset: content.indexOf("selected phrase"),
        utf16Length: "selected phrase".length,
      }, 0);
      const threadId = created[0].id;
      await replyToComment(project.root, project.path, threadId, "bob", "First reply", false, false, 1);
      await replyToComment(project.root, project.path, threadId, "cara", "Second reply", false, false, 2);
      await reportPlatform(page, "MacIntel");
      await page.goto("/");
      await openDocument(page, project);
      await page.locator(".cm-commentHighlight").click();
      const popover = page.getByRole("dialog", { name: "Comment thread" });
      const resolve = popover.getByRole("button", { name: "Resolve" });
      const disclosure = popover.locator(".comment-thread-card__replies summary");
      const reply = popover.getByRole("textbox", { name: "Reply to alice's comment" });
      await expect(disclosure).toHaveText("1 more replies");
      await resolve.hover();
      await expect(resolve).toHaveCSS("background-color", "rgb(240, 237, 230)");
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await expect(disclosure).toHaveCSS("color", "rgb(183, 192, 255)"); // accent ink: text set in the accent
      await expect(resolve).toHaveCSS("background-color", "rgb(38, 40, 44)");
      await resolve.focus();
      await expect(resolve).toHaveCSS("outline-color", "rgb(165, 176, 255)");
      await expect(resolve).toHaveCSS("outline-width", "2px");
      await reply.focus();
      await expect(reply).toHaveCSS("outline-color", "rgb(165, 176, 255)");
      await expect(reply).toHaveCSS("outline-width", "2px");
      const replyButton = popover.getByRole("button", { name: "Reply", exact: true });
      await replyButton.focus();
      await expect(replyButton).toHaveCSS("outline-color", "rgb(165, 176, 255)");
      const address = popover.getByRole("button", { name: "Address with AI" });
      await address.focus();
      await expect(address).toHaveCSS("outline-color", "rgb(165, 176, 255)");
    } finally {
      await project.cleanup(page);
    }
  });
});

test.describe("#2536 loaded comments column", () => {
  async function checkColumn(page, platform, expected) {
    const content = "# Notes\n\nA passage with a review question.\n";
    const project = createFixtureProject(content);
    const emptyPath = project.addFile("empty.md", "# Empty\n");
    try {
      const created = await createComment(project.root, project.path, "alice", "Open review note", null, 10);
      const resolved = await createComment(project.root, project.path, "alice", "Resolved review note", null, 20);
      await post("resolve_comment", {
        root: project.root, path: project.path, threadId: resolved.find((thread) => thread.body === "Resolved review note").id,
        author: "alice", timestamp: 30,
      });
      await reportPlatform(page, platform);
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto("/");
      await openDocument(page, project);
      await page.getByRole("button", { name: "Hide Timeline" }).click();
      const column = page.getByRole("region", { name: "Comments" });
      await expect(column.getByRole("heading", { name: "COMMENTS · 1 OPEN" })).toBeVisible();
      const card = column.locator(`[data-card-id="${created[0].id}"]`);
      await expect(card).toContainText("Open review note");
      await expect(column.getByRole("button", { name: "1 resolved threads hidden" })).toBeVisible();
      expect(await card.evaluate((element) => ({
        padding: getComputedStyle(element).padding,
        radius: getComputedStyle(element).borderRadius,
        margin: getComputedStyle(element).margin,
      }))).toEqual({ padding: "13px", radius: expected.radius, margin: "0px" });
      await column.getByRole("button", { name: "1 resolved threads hidden" }).click();
      await expect(column.getByText("Resolved review note")).toBeVisible();
      await openDocument(page, project, emptyPath);
      await expect(column.getByText("No comments in this document")).toBeVisible();
      await expect(column.getByRole("heading", { name: "COMMENTS", exact: true })).toBeVisible();
      await expect(column.getByRole("button", { name: "Position" })).toHaveCount(0);
      expect(await column.evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        background: getComputedStyle(element).backgroundColor,
      }))).toEqual({ width: 400, background: expected.background });
    } finally {
      await project.cleanup(page);
    }
  }

  test("Win32 keeps loaded cards and the empty column at the mock width", async ({ page }) => {
    await checkColumn(page, "Win32", { radius: "8px", background: "rgb(240, 237, 230)" });
  });

  test("MacIntel keeps loaded cards and the empty column at the mock width", async ({ page }) => {
    await checkColumn(page, "MacIntel", { radius: "10px", background: "rgb(237, 234, 226)" });
  });
});

test.describe("#2594 selection-time gutter add", () => {
  async function checkAdd(page, platform) {
    const content = `First and second passage share this paragraph. ${"More words make this paragraph wrap and reflow. ".repeat(20)}\n\nThird paragraph.\n`;
    const project = createFixtureProject(content);
    try {
      const [existing] = await createComment(project.root, project.path, "alice", "Existing note", {
        content, utf16Offset: 0, utf16Length: "First".length,
      }, 1);
      await reportPlatform(page, platform);
      await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    await openDocument(page, project);
    const editor = visibleEditor(page);
    await editor.focus();
    await page.keyboard.press(`${mod}+Home`);
    for (let i = 0; i < content.indexOf("second passage"); i += 1) await page.keyboard.press("ArrowRight");
    for (let i = 0; i < "second passage".length; i += 1) await page.keyboard.press("Shift+ArrowRight");
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("second passage");
      const add = page.getByRole("button", { name: "Add comment to selected text" });
      const existingIcon = page.locator(`[data-comment-gutter-thread="${existing.id}"]`);
      await expect(add).toBeVisible();
      await expect(add).toHaveText("+");
      await expect(add).toHaveCSS("border-color", "rgb(79, 70, 229)");
      await expect(add).toHaveCSS("background-color", "rgb(225, 224, 248)");
      // Threads load asynchronously, so the add can be drawn before the existing icon it must stack
      // below; the stacking rule is only measurable once both targets are in the gutter.
      await expect(existingIcon).toBeVisible();
      const [addBox, existingBox] = await Promise.all([add.boundingBox(), existingIcon.boundingBox()]);
      expect(addBox.width).toBe(24);
      expect(addBox.height).toBe(22);
      expect(addBox.y).toBeGreaterThanOrEqual(existingBox.y + existingBox.height + 2);
    expect(await add.evaluate((button) => button.getBoundingClientRect().right
      - button.closest(".cm-line").getBoundingClientRect().right)).toBeCloseTo(58, 0);
    await page.setViewportSize({ width: 1000, height: 900 });
    const narrowLineHeight = await editor.locator(".cm-line").first()
      .evaluate((line) => line.getBoundingClientRect().height);
    await page.setViewportSize({ width: 1800, height: 900 });
    await expect.poll(() => editor.locator(".cm-line").first()
      .evaluate((line) => line.getBoundingClientRect().height)).toBeLessThan(narrowLineHeight);
    const [reflowedAdd, reflowedExisting] = await Promise.all([add.boundingBox(), existingIcon.boundingBox()]);
    expect(reflowedAdd.y).toBeGreaterThanOrEqual(reflowedExisting.y + reflowedExisting.height + 2);

    await add.click();
    const composer = page.getByRole("dialog", { name: "New comment" });
    await expect(composer).toContainText("Commenting on: “second passage”");
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("second passage");
      await expect(add).toBeHidden();
    await composer.getByRole("button", { name: "Cancel" }).click();
    await expect(composer).toHaveCount(0);
    await expect(add).toBeVisible();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("second passage");
      expect((await loadCommentThreads(project.root, project.path)).map((thread) => thread.id)).toEqual([existing.id]);

      await add.focus();
      await page.keyboard.press("Enter");
      await expect(composer).toContainText("Commenting on: “second passage”");
      await composer.getByLabel("Comment").fill("New selected note");
      await composer.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(composer).toHaveCount(0);
      await expect.poll(async () => (await loadCommentThreads(project.root, project.path)).length).toBe(2);
      const created = (await loadCommentThreads(project.root, project.path)).find((thread) => thread.body === "New selected note");
      expect(created.anchor.text_snapshot).toBe("second passage");
      await expect(page.locator(`[data-comment-gutter-thread="${created.id}"]`)).toBeVisible();
    } finally {
      await project.cleanup(page);
    }
  }

  test("Win32 opens the existing anchored draft and cancel creates no thread", async ({ page }) => {
    await checkAdd(page, "Win32");
  });

  test("MacIntel opens the existing anchored draft and cancel creates no thread", async ({ page }) => {
    await checkAdd(page, "MacIntel");
  });
});

test.describe("#2537 reciprocal comments navigation", () => {
  test("a gutter icon selects its column card and a card reveals its live passage without moving the caret", async ({ page }) => {
    const content = `Top word begins the document.\n\n${Array.from({ length: 45 }, (_, i) => `Filler paragraph ${i}.\n\n`).join("")}Bottom word closes it.\n`;
    const project = createFixtureProject(content);
    try {
      const [top] = await createComment(project.root, project.path, "alice", "Top note", {
        content, utf16Offset: content.indexOf("Top word"), utf16Length: "Top word".length,
      }, 10);
      const bottomThreads = await createComment(project.root, project.path, "bob", "Bottom note", {
        content, utf16Offset: content.indexOf("Bottom word"), utf16Length: "Bottom word".length,
      }, 20);
      const bottom = bottomThreads.find((thread) => thread.body === "Bottom note");
      await reportPlatform(page, "Win32");
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto("/");
      await openDocument(page, project);
      await page.getByRole("button", { name: "Hide Timeline" }).click();
      const column = page.getByRole("region", { name: "Comments" });
      const editor = visibleEditor(page);
      await expect(column.locator(`[data-card-id="${top.id}"]`)).toHaveAttribute("aria-label", "Select comment thread 1 of 2");
      await expect(column.locator(`[data-card-id="${bottom.id}"]`)).toHaveAttribute("aria-label", "Select comment thread 2 of 2");
      await editor.locator(".cm-line").first().click();
      await page.keyboard.press("Home");
      await page.keyboard.press("Shift+ArrowRight");
      const selectedText = await page.evaluate(() => window.getSelection()?.toString());
      expect(selectedText).toBe("T");

      await page.locator(`[data-comment-gutter-thread="${top.id}"]`).click();
      await expect(column.locator(`[data-card-id="${top.id}"]`)).toHaveAttribute("aria-current", "true");
      await expect(page.locator(".cm-commentHighlight-selected")).toHaveText("Top word");
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selectedText);
      await expect(editor).toBeFocused();

      await column.locator(`[data-card-id="${bottom.id}"]`).getByText("Bottom note").click();
      await expect(column.locator(`[data-card-id="${bottom.id}"]`)).toHaveAttribute("aria-current", "true");
      await expect(page.locator(".cm-commentHighlight-selected")).toHaveText("Bottom word");
      await expect(page.locator(".cm-commentHighlight-selected")).toBeInViewport();
      await expect(editor).toBeFocused();
      await page.keyboard.type("Z");
      await expect(editor).toContainText("Zop word begins the document.");
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
    } finally {
      await project.cleanup(page);
    }
  });

  test("a withdrawn placeholder keeps its moved passage route but has no gutter icon", async ({ page }) => {
    const content = `${Array.from({ length: 45 }, (_, i) => `Filler paragraph ${i}.\n\n`).join("")}The target passage remains here.\n`;
    const project = createFixtureProject(content);
    try {
      const [created] = await createComment(project.root, project.path, "you", "Withdrawn note", {
        content, utf16Offset: content.indexOf("target passage"), utf16Length: "target passage".length,
      }, 1);
      const [docId] = readdirSync(join(project.root, ".emend", "comments"));
      appendFileSync(join(project.root, ".emend", "comments", docId, "emend.jsonl"), JSON.stringify({
        schema_version: 1, id: `publish-${created.id}`, parent_id: created.id,
        author: "emend", timestamp: 2, type: "publish",
      }) + "\n");
      project.overwrite(`New prefix. ${content}`);
      await page.goto("/");
      await openDocument(page, project);
      const timelineCard = page.locator(`.timeline-panel [data-card-id="${created.id}"]`);
      await timelineCard.getByRole("button", { name: "Comment actions" }).click();
      await timelineCard.getByRole("button", { name: "Delete comment" }).click();
      await timelineCard.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("button", { name: "Hide Timeline" }).click();
      const column = page.getByRole("region", { name: "Comments" });
      await column.getByRole("button", { name: "1 hidden threads" }).click();
      const card = column.locator(`[data-card-id="${created.id}"]`);
      await expect(card.getByRole("button", { name: "→ Go to passage" })).toBeVisible();
      await expect(page.locator(`[data-comment-gutter-thread="${created.id}"]`)).toHaveCount(0);
      await card.getByRole("button", { name: "→ Go to passage" }).click();
      await expect(page.locator(".cm-line", { hasText: "target passage" })).toBeInViewport();
      await expect(card).toHaveAttribute("aria-current", "true");
    } finally {
      await project.cleanup(page);
    }
  });

  test("an untitled document connects its UUID-owned gutter and collapsed card before Save As", async ({ page }) => {
    const content = "Hello untitled passage.\n";
    const project = createFixtureProject("# Former file\n");
    const recoveryPath = "untitled:1:notes.md";
    try {
      const emendDir = join(project.root, ".emend");
      mkdirSync(emendDir, { recursive: true });
      writeFileSync(join(emendDir, "tab-session.json"), JSON.stringify({
        schema_version: 1,
        tabs: [{ path: recoveryPath, unsaved_content: content, recovered_from: project.path }],
        active_path: recoveryPath,
      }));
      await page.goto("/");
      await page.evaluate(({ root, path }) => window.__EMEND_E2E__?.openProject(root, path), {
        root: project.root, path: recoveryPath,
      });
      const editor = page.getByRole("textbox", { name: "Untitled document text" });
      await editor.focus();
      await page.keyboard.press(`${mod}+Home`);
      for (let i = 0; i < 5; i += 1) await page.keyboard.press("Shift+ArrowRight");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      const composer = page.getByRole("dialog", { name: "New comment" });
      await composer.getByLabel("Comment").fill("Pathless note");
      await composer.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(page.locator(".cm-commentHighlight", { hasText: "Hello" })).toBeVisible();
      await page.getByRole("button", { name: "Hide Timeline" }).click();
      const column = page.getByRole("region", { name: "Comments" });
      const card = column.locator('[data-card-kind="comment"]');
      const id = await card.getAttribute("data-card-id");
      await page.locator(`[data-comment-gutter-thread="${id}"]`).click();
      await expect(card).toHaveAttribute("aria-current", "true");
      await expect(page.getByRole("dialog", { name: "Comment thread" })).toHaveCount(0);
      await card.getByText("Pathless note").click();
      await expect(page.locator(".cm-commentHighlight-selected")).toHaveText("Hello");
    } finally {
      await project.cleanup(page);
    }
  });

  test("a hidden resolved thread is revealed from its gutter and keeps identity when reopened", async ({ page }) => {
    const content = "An anchored review passage.\n";
    const project = createFixtureProject(content);
    try {
      const [created] = await createComment(project.root, project.path, "alice", "Resolved note", {
        content, utf16Offset: content.indexOf("review passage"), utf16Length: "review passage".length,
      }, 1);
      await post("resolve_comment", {
        root: project.root, path: project.path, threadId: created.id, author: "alice", timestamp: 2,
      });
      await page.goto("/");
      await openDocument(page, project);
      await page.getByRole("button", { name: "Hide Timeline" }).click();
      const column = page.getByRole("region", { name: "Comments" });
      await expect(column.getByRole("button", { name: "1 resolved threads hidden" })).toBeVisible();
      const icon = page.locator(`[data-comment-gutter-thread="${created.id}"]`);
      await expect(icon).toHaveClass(/cm-commentGutterIcon-resolved/);
      await icon.focus();
      await page.keyboard.press("Enter");
      const card = column.locator(`[data-card-id="${created.id}"]`);
      await expect(card).toBeVisible();
      await expect(card).toHaveAttribute("aria-current", "true");
      await card.locator(".comment-thread-card__collapsed").click();
      await card.getByRole("button", { name: "Reopen" }).click();
      await expect(card.getByText("Open", { exact: true })).toBeVisible();
      await expect(page.locator(`[data-comment-gutter-thread="${created.id}"]`)).toHaveClass(/cm-commentGutterIcon-selected/);
    } finally {
      await project.cleanup(page);
    }
  });

  test("nearby anchors keep paragraph attachment and non-overlapping gutter targets", async ({ page }) => {
    const content = "First and second and extra anchors share this paragraph, with a few more words for wrapping.\n\nThird anchor begins the next paragraph.\n";
    const project = createFixtureProject(content);
    try {
      const ids = [];
      for (const [word, body, timestamp] of [["First", "First note", 1], ["second", "Second note", 2], ["extra", "Extra note", 3], ["Third", "Third note", 4]]) {
        const created = await createComment(project.root, project.path, "alice", body, {
          content, utf16Offset: content.indexOf(word), utf16Length: word.length,
        }, timestamp);
        ids.push(created.find((thread) => thread.body === body).id);
      }
      await page.setViewportSize({ width: 1000, height: 900 });
      await page.goto("/");
      await openDocument(page, project);
      for (const id of ids) {
        await expect(page.locator(`[data-comment-gutter-thread="${id}"]`)).toHaveCount(1);
      }
      const boxes = await page.locator(".cm-editor").evaluate((editor, ids) => ids.map((id) => {
        const icon = editor.querySelector(`[data-comment-gutter-thread="${id}"]`);
        const line = icon.closest(".cm-line");
        const box = icon.getBoundingClientRect();
        const lineBox = line.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, right: box.right, width: box.width,
          lineTop: lineBox.top, lineRight: lineBox.right, lineText: line.textContent };
      }), ids);
      expect(boxes[0].lineText).toContain("First and second");
      expect(boxes[1].lineText).toContain("First and second");
      expect(boxes[2].lineText).toContain("First and second");
      expect(boxes[3].lineText).toContain("Third anchor");
      for (let i = 1; i < boxes.length; i += 1) {
        expect(boxes[i].top).toBeGreaterThanOrEqual(boxes[i - 1].bottom + 2);
      }
      expect(boxes[0].top - boxes[0].lineTop).toBeGreaterThanOrEqual(1);
      expect(boxes[0].top - boxes[0].lineTop).toBeLessThanOrEqual(3);
      expect(boxes[0].width).toBe(24);
      expect(boxes[0].right - boxes[0].lineRight).toBeCloseTo(56, 0);
      const narrowLineHeight = await page.locator(".cm-line", { hasText: "First and second" }).first()
        .evaluate((line) => line.getBoundingClientRect().height);
      await page.setViewportSize({ width: 1800, height: 900 });
      await expect.poll(() => page.locator(".cm-line", { hasText: "First and second" }).first()
        .evaluate((line) => line.getBoundingClientRect().height)).toBeLessThan(narrowLineHeight);
      const wideLineHeight = await page.locator(".cm-line", { hasText: "First and second" }).first()
        .evaluate((line) => line.getBoundingClientRect().height);
      const gutterBoxes = () => page.locator(".cm-editor").evaluate((editor, ids) => ids.map((id) => {
        const icon = editor.querySelector(`[data-comment-gutter-thread="${id}"]`);
        const box = icon.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom,
          lineTop: icon.closest(".cm-line").getBoundingClientRect().top };
      }), ids);
      await expect.poll(async () => {
        const positions = await gutterBoxes();
        return positions.every((box, index) => index === 0 || box.top >= positions[index - 1].bottom + 2);
      }).toBe(true);
      const widened = await gutterBoxes();
      for (let i = 1; i < widened.length; i += 1) {
        expect(widened[i].top).toBeGreaterThanOrEqual(widened[i - 1].bottom + 2);
      }
      expect(widened[3].top - widened[3].lineTop).toBeGreaterThan(2);
      await page.locator(".cm-content").evaluate((content) => { content.style.fontSize = "24px"; });
      await expect.poll(() => page.locator(".cm-line", { hasText: "First and second" }).first()
        .evaluate((line) => line.getBoundingClientRect().height)).toBeGreaterThan(wideLineHeight);
      const afterFontChange = await page.locator(`[data-comment-gutter-thread="${ids[3]}"]`)
        .evaluate((icon) => ({ iconTop: icon.getBoundingClientRect().top,
          lineTop: icon.closest(".cm-line").getBoundingClientRect().top }));
      expect(afterFontChange.iconTop - afterFontChange.lineTop).toBeCloseTo(2, 0);
    } finally {
      await project.cleanup(page);
    }
  });

  test("selection remains with its document across tab switches", async ({ page }) => {
    const content = "A shared word in each document.\n";
    const project = createFixtureProject(content);
    const secondPath = project.addFile("second.md", content);
    try {
      const [first] = await createComment(project.root, project.path, "alice", "First document note", {
        content, utf16Offset: content.indexOf("shared"), utf16Length: "shared".length,
      }, 1);
      const [second] = await createComment(project.root, secondPath, "bob", "Second document note", {
        content, utf16Offset: content.indexOf("shared"), utf16Length: "shared".length,
      }, 2);
      await page.goto("/");
      await openDocument(page, project);
      await page.getByRole("button", { name: "Hide Timeline" }).click();
      const column = page.getByRole("region", { name: "Comments" });
      await page.locator(`[data-comment-gutter-thread="${first.id}"]`).click();
      await expect(column.locator(`[data-card-id="${first.id}"]`)).toHaveAttribute("aria-current", "true");
      await openDocument(page, project, secondPath);
      await expect(column.locator(`[data-card-id="${second.id}"]`)).toBeVisible();
      await expect(column.locator(`[data-card-id="${first.id}"]`)).toHaveCount(0);
      await expect(page.locator(`[data-comment-gutter-thread="${second.id}"]`)).not.toHaveClass(/selected/);
      await page.getByRole("tab", { name: project.path, exact: false }).click();
      await expect(column.locator(`[data-card-id="${first.id}"]`)).toHaveAttribute("aria-current", "true");
      await expect(page.locator(`[data-comment-gutter-thread="${first.id}"]`)).toHaveClass(/selected/);
    } finally {
      await project.cleanup(page);
    }
  });

  test("a selected card remains revealed when Recency moves it below the column viewport", async ({ page }) => {
    const content = Array.from({ length: 8 }, (_, i) => `Passage ${i} is anchored here.\n\n`).join("");
    const project = createFixtureProject(content);
    try {
      let firstId;
      for (let i = 0; i < 8; i += 1) {
        const created = await createComment(project.root, project.path, "alice", `Note ${i}`, {
          content, utf16Offset: content.indexOf(`Passage ${i}`), utf16Length: `Passage ${i}`.length,
        }, i + 1);
        if (i === 0) firstId = created.find((thread) => thread.body === "Note 0").id;
      }
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.goto("/");
      await openDocument(page, project);
      await page.getByRole("button", { name: "Hide Timeline" }).click();
      const column = page.getByRole("region", { name: "Comments" });
      const card = column.locator(`[data-card-id="${firstId}"]`);
      await card.getByText("Note 0").click();
      await expect(card).toHaveAttribute("aria-current", "true");
      await column.getByRole("button", { name: "Position" }).click();
      await column.getByRole("menuitem", { name: "Recency" }).click();
      await expect(card).toBeInViewport();
      expect(await column.locator(".comments-column__body").evaluate((body) => body.scrollTop)).toBeGreaterThan(0);
    } finally {
      await project.cleanup(page);
    }
  });

  test("a document-level thread selects honestly without claiming a passage or moving the editor", async ({ page }) => {
    const content = "A document without an anchor for this note.\n";
    const project = createFixtureProject(content);
    try {
      const [created] = await createComment(project.root, project.path, "alice", "Whole-document note", null, 1);
      await page.goto("/");
      await openDocument(page, project);
      await page.getByRole("button", { name: "Hide Timeline" }).click();
      const editor = visibleEditor(page);
      await editor.locator(".cm-line").first().click();
      const before = await page.locator(".editor-shell__host").evaluate((host) => host.scrollTop);
      const card = page.getByRole("region", { name: "Comments" }).locator(`[data-card-id="${created.id}"]`);
      await card.getByText("Whole-document note").click();
      await expect(card).toHaveAttribute("aria-current", "true");
      await expect(page.locator(".shell-status")).toHaveCount(0);
      expect(await page.locator(".editor-shell__host").evaluate((host) => host.scrollTop)).toBe(before);
      await expect(editor).toBeFocused();
      await expect(page.locator(".cm-commentGutterIcon")).toHaveCount(0);
    } finally {
      await project.cleanup(page);
    }
  });

  test("dragging comment body text selects it without activating its column card", async ({ page }) => {
    const content = "A passage has a comment.\n";
    const project = createFixtureProject(content);
    try {
      const [created] = await createComment(project.root, project.path, "alice",
        "A long selectable comment body with a phrase to copy", {
          content, utf16Offset: content.indexOf("passage"), utf16Length: "passage".length,
        }, 1);
      await page.goto("/");
      await openDocument(page, project);
      await page.getByRole("button", { name: "Hide Timeline" }).click();
      const card = page.getByRole("region", { name: "Comments" }).locator(`[data-card-id="${created.id}"]`);
      const body = card.getByText("A long selectable comment body with a phrase to copy");
      const box = await body.boundingBox();
      expect(box).not.toBeNull();
      await page.mouse.move(box.x + 4, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      expect((await page.evaluate(() => window.getSelection()?.toString() ?? "")).length).toBeGreaterThan(8);
      await expect(card).not.toHaveAttribute("aria-current", "true");
    } finally {
      await project.cleanup(page);
    }
  });
});

test.describe("J10 own-comment correction", () => {
  test("#2574 withdrawn placeholder keyboard route resolves a moved passage", async ({ page }) => {
    const content = "A selected phrase remains in the document.\n";
    const project = createFixtureProject(content);
    try {
      const [created] = await createComment(project.root, project.path, "you", "Original note", {
        content,
        utf16Offset: content.indexOf("selected phrase"),
        utf16Length: "selected phrase".length,
      }, 1);
      // Review sync has no producer yet. Seed the durable D20 publication fact through its real
      // sidecar schema so the own-author Delete route retains the placeholder.
      const [docId] = readdirSync(join(project.root, ".emend", "comments"));
      appendFileSync(join(project.root, ".emend", "comments", docId, "emend.jsonl"), JSON.stringify({
        schema_version: 1, id: `publish-${created.id}`, parent_id: created.id,
        author: "emend", timestamp: 2, type: "publish",
      }) + "\n");
      project.overwrite(`New prefix. ${content}`);
      await page.goto("/");
      await openDocument(page, project);
      const card = page.locator('.timeline-panel [data-card-kind="comment"]');
      await card.getByRole("button", { name: "Comment actions" }).click();
      await card.getByRole("button", { name: "Delete comment" }).click();
      await card.getByRole("button", { name: "Delete", exact: true }).click();
      const route = card.getByRole("button", { name: "→ Go to passage" });
      await expect(route).toBeVisible();

      await route.focus();
      await page.keyboard.press("Enter");

      await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("selected phrase");
      await expect(visibleEditor(page)).toContainText(`New prefix. ${content.trim()}`);
    } finally {
      await project.cleanup(page);
    }
  });

  test("a reply arriving during Delete confirmation is shown with the refusal", async ({ page }) => {
    const content = "A selected phrase remains in the document.\n";
    const project = createFixtureProject(content);
    try {
      const created = await createComment(project.root, project.path, "you", "Original note", {
        content,
        utf16Offset: content.indexOf("selected phrase"),
        utf16Length: "selected phrase".length,
      }, 1);
      await page.goto("/");
      await openDocument(page, project);
      await page.locator(".cm-commentHighlight").click();
      const popover = page.getByRole("dialog", { name: "Comment thread" });
      await popover.getByRole("button", { name: "Comment actions" }).click();
      await popover.getByRole("button", { name: "Delete comment" }).click();
      await expect(popover.getByText("Delete this comment?")).toBeVisible();

      await replyToComment(project.root, project.path, created[0].id, "you", "New reply", false, false, 2);
      await popover.getByRole("button", { name: "Delete", exact: true }).click();

      await expect(popover.getByText("Not deleted")).toBeVisible();
      await expect(popover.getByText("Delete replies first.")).toBeVisible();
      await expect(popover.getByText("New reply")).toBeVisible();
      await expect(popover.getByRole("button", { name: "Comment actions" })).toBeFocused();

      await popover.getByRole("button", { name: "Reply actions" }).click();
      await popover.getByRole("button", { name: "Delete reply" }).click();
      await popover.getByRole("button", { name: "Delete", exact: true }).click();
      await expect.poll(async () => typeof (await loadCommentThreads(project.root, project.path))[0]?.replies[0]?.withdrawn_at).toBe("number");
      await expect(popover.getByText("Not deleted")).toHaveCount(0);
      await expect(popover.getByText("Delete replies first.")).toHaveCount(0);
      await popover.getByRole("button", { name: "Comment actions" }).click();
      await expect(popover.getByRole("button", { name: "Delete comment" })).toBeEnabled();
    } finally {
      await project.cleanup(page);
    }
  });

  test("a live reply blocks root Delete while its own Delete reply remains available", async ({ page }) => {
    const content = "A selected phrase remains in the document.\n";
    const project = createFixtureProject(content);
    try {
      const created = await createComment(project.root, project.path, "you", "Original note", {
        content,
        utf16Offset: content.indexOf("selected phrase"),
        utf16Length: "selected phrase".length,
      }, 1);
      await replyToComment(project.root, project.path, created[0].id, "you", "My reply", false, false, 2);
      await page.goto("/");
      await openDocument(page, project);
      await page.locator(".cm-commentHighlight").click();
      const popover = page.getByRole("dialog", { name: "Comment thread" });
      await popover.getByRole("button", { name: "Comment actions" }).click();
      await expect(popover.getByRole("button", { name: "Delete comment" })).toBeDisabled();
      await expect(popover.getByText("Delete replies first.")).toBeVisible();
      await expect(popover.getByRole("button", { name: "Resolve", exact: true })).toBeEnabled();
      await popover.getByRole("button", { name: "Comment actions" }).click();
      await popover.getByRole("button", { name: "Reply actions" }).click();
      await popover.getByRole("button", { name: "Delete reply" }).click();
      await expect(popover.getByText("Delete this reply?")).toBeVisible();
      await popover.getByRole("button", { name: "Delete", exact: true }).click();
      await expect.poll(async () => typeof (await loadCommentThreads(project.root, project.path))[0]?.replies[0]?.withdrawn_at).toBe("number");
      await popover.getByRole("button", { name: "Comment actions" }).click();
      await expect(popover.getByRole("button", { name: "Delete comment" })).toBeEnabled();
    } finally {
      await project.cleanup(page);
    }
  });

  test("an anchored own comment can be edited and confirmed for Delete through the real command path", async ({ page }) => {
    const content = "A selected phrase remains in the document.\n";
    const project = createFixtureProject(content);
    try {
      const created = await createComment(project.root, project.path, "you", "Original note", {
        content,
        utf16Offset: content.indexOf("selected phrase"),
        utf16Length: "selected phrase".length,
      }, 1);
      const threadId = created[0].id;
      await page.goto("/");
      await openDocument(page, project);
      await page.locator(".cm-commentHighlight").click();
      const popover = page.getByRole("dialog", { name: "Comment thread" });
      await popover.getByRole("button", { name: "Edit comment" }).click();
      await popover.getByRole("textbox", { name: "Edit comment body" }).fill("Revised note");
      await popover.getByRole("button", { name: "Save", exact: true }).click();
      await expect(popover).toContainText("Revised note");
      await expect.poll(async () => (await loadCommentThreads(project.root, project.path))[0]?.body).toBe("Revised note");
      expect((await loadCommentThreads(project.root, project.path))[0].id).toBe(threadId);

      await popover.getByRole("button", { name: "Comment actions" }).click();
      await popover.getByRole("button", { name: "Delete comment" }).click();
      await expect(popover).toContainText("Delete this comment?");
      await popover.getByRole("button", { name: "Delete", exact: true }).click();
      await expect.poll(async () => (await loadCommentThreads(project.root, project.path)).length).toBe(0);
      await expect(page.locator(".cm-commentHighlight")).toHaveCount(0);
    } finally {
      await project.cleanup(page);
    }
  });

  test("the no-author correction route refuses a foreign comment even with a forged author field", async ({ page }) => {
    const project = createFixtureProject("A note.\n");
    try {
      const created = await createComment(project.root, project.path, "alice", "Reviewer text", null, 1);
      const targetId = created[0].id;
      await page.goto("/");
      await openDocument(page, project);
      await expect(page.getByRole("button", { name: "Edit comment" })).toHaveCount(0);
      await expect(post("revise_own_comment", {
        root: project.root,
        path: project.path,
        targetId,
        author: "alice",
        body: "Forged edit",
        timestamp: 2,
      })).rejects.toThrow("Only the author can edit or delete this comment.");
      expect((await loadCommentThreads(project.root, project.path))[0].body).toBe("Reviewer text");
    } finally {
      await project.cleanup(page);
    }
  });
});

test("#2538 collapsed comment run link follows the submitted dirty envelope and reveals its terminal run", async ({ page }) => {
  const content = "A passage needs a clearer explanation.\n";
  const project = createFixtureProject(content);
  try {
    const [created] = await createComment(project.root, project.path, "alice", "Clarify this passage", {
      content, utf16Offset: content.indexOf("passage"), utf16Length: "passage".length,
    }, 1);
    await reportPlatform(page, "Win32");
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    await openDocument(page, project);
    const editor = visibleEditor(page);
    await editor.click();
    await page.keyboard.press(`${mod}+End`);
    await page.keyboard.type(" Revised while unsaved.");
    await expect(page.getByRole("tab", { name: /\.md/ })).toHaveAttribute("data-dirty", "true");
    await page.getByRole("button", { name: "Hide Timeline" }).click();
    const column = page.getByRole("region", { name: "Comments" });
    const card = column.locator(`[data-card-id="${created.id}"]`);
    const request = page.waitForRequest((candidate) => candidate.url().endsWith("/start_address_run"));
    await card.getByRole("button", { name: "Address with AI" }).click();
    const submitted = (await request).postDataJSON();
    const envelopeLine = submitted.referenceData.split("\n").find((line) => line.includes('"kind":"open_documents"'));
    const envelope = JSON.parse(envelopeLine);
    expect(envelope.active.content).toContain("Revised while unsaved.");
    const link = card.getByRole("button", { name: "Show the run" });
    await expect(link).toBeVisible();
    await expect(card.getByText("Unsaved text sent with this run")).toBeVisible();
    await expect(card.getByRole("button", { name: "Show the run" })).toHaveCount(1);
    expect(await card.locator(".comment-thread-card__run-link").evaluate((element) => ({
      borderTop: getComputedStyle(element).borderTopWidth,
      paddingTop: getComputedStyle(element).paddingTop,
      wrap: getComputedStyle(element).flexWrap,
    }))).toEqual({ borderTop: "1px", paddingTop: "7px", wrap: "wrap" });
    await expect.poll(async () => (await loadCommentThreads(project.root, project.path))[0]?.concluded_run?.outcome)
      .toBe("failed");
    const runId = (await loadCommentThreads(project.root, project.path))[0].concluded_run.run_id;
    await page.keyboard.press("Tab");
    await link.focus();
    await expect(link).toHaveCSS("outline-width", "2px");
    await page.keyboard.press("Enter");
    await expect(column).toHaveCount(0);
    const runCard = page.locator(`.timeline-panel [data-card-kind="agent-working"][data-card-id="${runId}"]`);
    await expect(runCard).toBeVisible();
    await expect(runCard).toBeFocused();
    const landing = await page.locator('.timeline-panel [data-testid="virtual-list"]').evaluate((element) => {
      const card = element.querySelector('[data-card-kind="agent-working"]');
      return card.getBoundingClientRect().top - element.getBoundingClientRect().top;
    });
    expect(landing).toBeGreaterThanOrEqual(11);
    expect(landing).toBeLessThanOrEqual(13);
    await expect(editor).toContainText("Revised while unsaved.");
  } finally {
    await project.cleanup(page);
  }
});

test.describe("P2a-2 walking skeleton", () => {
  /** @type {ReturnType<typeof createFixtureProject>} */
  let project;

  test.beforeEach(() => {
    project = createFixtureProject("# Walking skeleton\n");
  });

  test.afterEach(async ({ page }) => {
    await project.cleanup(page);
  });

  test("the app page stays fixed when content exceeds the shell boundary", async ({ page }) => {
    project.overwrite("Long document paragraph.\n\n".repeat(100));
    await reportPlatform(page, "MacIntel");
    await page.setViewportSize({ width: 720, height: 480 });
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Open a folder…" })).toBeInViewport();
    const welcome = page.locator(".welcome-screen");
    await welcome.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(page.getByRole("region", { name: "GitHub" })).toBeInViewport();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.setViewportSize({ width: 1400, height: 900 });
    await openDocument(page, project);

    await page.evaluate(() => {
      const overflowProbe = document.createElement("div");
      overflowProbe.style.height = "400px";
      overflowProbe.setAttribute("aria-hidden", "true");
      document.getElementById("root").append(overflowProbe);
      const bodyOverflowProbe = document.createElement("div");
      bodyOverflowProbe.style.height = "400px";
      bodyOverflowProbe.setAttribute("aria-hidden", "true");
      document.body.append(bodyOverflowProbe);
      window.scrollTo(0, 900);
    });
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.mouse.move(10, 10);
    await page.mouse.wheel(0, 900);
    await page.evaluate(() => new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);

    const editorScroll = page.locator(".editor-shell__host:visible");
    await editorScroll.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    expect(await editorScroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  });

  test("TD-25 reports an unhandled rejection without silencing Chromium", async ({ page }) => {
    await page.goto("/");
    const runtimeError = page.waitForEvent("pageerror");

    await page.evaluate(() => {
      void Promise.reject(new Error("native dialog failed"));
    });

    const error = await runtimeError;
    expect(error.message).toContain("native dialog failed");
    const status = page.locator(".shell-status");
    await expect(status).toHaveText(
      "Something inside Emend didn’t finish. If something doesn’t look right, this may be why. native dialog failedDismiss",
    );
    await status.getByRole("button", { name: "Dismiss message" }).click();
    await expect(status).toHaveCount(0);
  });

  test("J15 contains a production render throw, reports pageerror, and remounts through ordinary entry", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Open a folder…" })).toBeVisible();
    const runtimeError = page.waitForEvent("pageerror");

    await page.evaluate(() => window.__EMEND_E2E__?.triggerRenderFailure());

    const error = await runtimeError;
    expect(error.message).toContain("D23 render-failure acceptance probe");
    const fallback = page.getByRole("main", {
      name: "Emend can’t show this window right now.",
    });
    await expect(fallback).toBeFocused();
    await expect(fallback).toContainText("Reloading starts Emend again.");
    await expect(fallback).not.toContainText("D23 render-failure acceptance probe");

    const reload = fallback.getByRole("button", { name: "Reload window" });
    await reload.click();
    await expect(page.getByRole("button", { name: "Open a folder…" })).toBeVisible();
    await expect(fallback).toHaveCount(0);
  });

  test("launch app -> open project/doc -> type -> save -> verify saved content on disk", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("button", { name: "Open a folder…" })).toBeVisible();

    // The real folder-picker UI exists (P2a-22), but it's a native OS dialog Playwright can't
    // drive — the dev-only e2e test hook (D23) opens the fixture project/doc directly instead,
    // through the same real `open_document` command the picker's restored tab ultimately calls.
    await page.evaluate(
      ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
      { root: project.root, path: project.path },
    );

    const editor = page.locator(".cm-content");
    await expect(editor).toBeVisible();
    await expect(editor).toContainText("Walking skeleton");

    const revised = "# Walking skeleton\n\nSaved via the e2e walking skeleton.";
    await editor.click();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.type(revised);

    await page.keyboard.press(`${mod}+s`);

    // Condition-based: polls the real file on disk until the async save lands, no fixed sleep.
    await expect.poll(() => project.readSaved()).toBe(revised);
  });

  test("file-backed rich text uses the bundled document-body typography (#2386)", async ({
    page,
  }) => {
    project.overwrite("Document body with **strong**, *emphasis*, and ***both***.\n");
    await page.goto("/");
    await openDocument(page, project);

    const typography = await visibleEditor(page).evaluate(async (editor) => {
      await document.fonts.ready;
      const style = getComputedStyle(editor);
      const sourceSerifFaces = [...document.fonts]
        .filter((face) => face.family.replaceAll('"', "") === "Source Serif 4")
        .map((face) => `${face.style} ${face.weight} ${face.status}`)
        .sort();
      return {
        color: style.color,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        lineHeight: style.lineHeight,
        sourceSerifFaces,
      };
    });

    expect(typography).toEqual({
      color: "rgb(51, 48, 42)",
      fontFamily: '"Source Serif 4", Georgia, serif',
      fontSize: "15.5px",
      lineHeight: "27.125px",
      sourceSerifFaces: [
        "italic 400 loaded",
        "italic 700 loaded",
        "normal 400 loaded",
        "normal 700 loaded",
      ],
    });
  });

  test("B1 file-backed shell uses the warm palette and measured document canvas", async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    await openDocument(page, project);
    await chooseTheme(page, "Light");

    const appearance = await page.evaluate(async () => {
      await document.fonts.ready;
      const root = getComputedStyle(document.documentElement);
      const shell = getComputedStyle(document.querySelector(".app-shell"));
      const host = getComputedStyle(document.querySelector(".editor-shell__host"));
      const content = getComputedStyle(document.querySelector(".editor-shell__host .cm-content"));
      return {
        background: root.getPropertyValue("--color-bg").trim(),
        canvasToken: root.getPropertyValue("--color-editor-canvas-bg").trim(),
        surface: root.getPropertyValue("--color-surface").trim(),
        foreground: root.getPropertyValue("--color-fg").trim(),
        muted: root.getPropertyValue("--color-muted").trim(),
        border: root.getPropertyValue("--color-border").trim(),
        accent: root.getPropertyValue("--color-accent").trim(),
        uiFont: shell.fontFamily,
        ibmPlexFaces: [...document.fonts]
          .filter((face) => face.family.replaceAll('"', "") === "IBM Plex Sans" && face.status === "loaded")
          .map((face) => `${face.style} ${face.weight}`)
          .sort(),
        canvasBackground: getComputedStyle(document.querySelector(".editor-shell__host")).backgroundColor,
        canvasPadding: host.padding,
        documentFont: content.fontFamily,
      };
    });
    expect(appearance).toEqual({
      background: "#ffffff",
      canvasToken: "#fcfbf8",
      surface: "#faf8f3",
      foreground: "#1f1d1a",
      muted: "#6b665c",
      border: "#e3dfd6",
      accent: "#4f46e5",
      uiFont: '"IBM Plex Sans", system-ui, sans-serif',
      ibmPlexFaces: ["normal 400", "normal 500", "normal 600"],
      canvasBackground: "rgb(252, 251, 248)",
      canvasPadding: "34px 96px 34px 72px",
      documentFont: '"Source Serif 4", Georgia, serif',
    });

    for (const [width, padding] of [[1001, "34px 96px 34px 72px"], [1000, "8px"]]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator(".editor-shell__host")).toHaveCSS("padding", padding);
    }

    await chooseTheme(page, "Dark");
    const dark = await page.locator(".app-shell").evaluate((shell) => ({
      background: getComputedStyle(shell).backgroundColor,
      foreground: getComputedStyle(shell).color,
      canvasBackground: getComputedStyle(document.querySelector(".editor-shell__host")).backgroundColor,
    }));
    expect(dark.background).toBe("rgb(30, 31, 34)");
    expect(dark.foreground).toBe("rgb(230, 231, 234)");
    expect(dark.canvasBackground).toBe("rgb(30, 31, 34)");
  });

  test("an OS Open-document request reaches the mounted production menu listener through D23 (#1827)", async ({
    page,
  }) => {
    const secondPath = "opened-from-menu.md";
    const absolute = join(project.root, secondPath);
    writeFileSync(absolute, "# Opened from File menu\n", "utf8");
    await page.goto("/");
    await openDocument(page, project);
    await page.evaluate(
      (path) => window.__EMEND_E2E__?.setNextOpenDocumentDialogResult(path),
      absolute,
    );

    await post("request_open_document", {});

    await expect(page.getByRole("tab", { name: /opened-from-menu\.md/ })).toBeVisible();
    await expect(visibleEditor(page)).toContainText("Opened from File menu");
  });

  test("an OS Save-As request reaches the active editor through the production menu listener (#1827)", async ({
    page,
  }) => {
    const destination = join(project.root, "saved-from-menu.md");
    await page.goto("/");
    await openDocument(page, project);
    await page.evaluate(
      (path) => window.__EMEND_E2E__?.setNextSaveAsDialogResult(path),
      destination,
    );

    await post("request_save_document_as", {});

    await expect(page.getByRole("tab", { name: /saved-from-menu\.md/ })).toBeVisible();
    await expect.poll(() => readFileSync(destination, "utf8")).toBe("# Walking skeleton\n");
  });

  test("a long wrapped document scrolls inside the editor and can return to its first line", async ({
    page,
  }) => {
    const proseLine =
      "A wrapped prose line stays inside the document viewport instead of widening the editor.";
    project.overwrite(
      Array.from({ length: 200 }, (_, index) => `${index + 1}. ${proseLine}`).join("\n"),
    );

    await page.goto("/");
    await page.evaluate(
      ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
      { root: project.root, path: project.path },
    );

    const scrollHost = page.locator(".editor-shell__host");
    await expect(scrollHost.locator(".cm-content")).toBeVisible();
    await expect
      .poll(() => scrollHost.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);

    await scrollHost.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect.poll(() => scrollHost.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await scrollHost.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect.poll(() => scrollHost.evaluate((element) => element.scrollTop)).toBe(0);

    const firstLine = scrollHost.locator(".cm-line").first();
    await expect(firstLine).toContainText(`1. ${proseLine}`);
    const [hostBox, firstLineBox] = await Promise.all([
      scrollHost.boundingBox(),
      firstLine.boundingBox(),
    ]);
    expect(hostBox).not.toBeNull();
    expect(firstLineBox).not.toBeNull();
    expect(firstLineBox.y).toBeGreaterThanOrEqual(hostBox.y);
    expect(firstLineBox.y).toBeLessThan(hostBox.y + hostBox.height);
  });

  test("the document column fills its lane with no outer inset and carries its own hairline border (#1369 authoring-shell.md)", async ({
    page,
  }) => {
    // Real Chromium, not jsdom: `.editor-region`'s border is `var(--color-editor-region-border)`,
    // and jsdom's CSSOM doesn't resolve custom properties inside a border shorthand (confirmed
    // while writing `src/appShellLayout.test.tsx`'s sibling coverage of this same fix) — this is
    // the one assertion this card's regression needs a real browser for.
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    await page.evaluate(
      ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
      { root: project.root, path: project.path },
    );
    await expect(page.locator(".cm-content")).toBeVisible();

    // One round trip for the style declarations and both elements' geometry — they're
    // independent reads with no ordering dependency on each other.
    const layout = await page.evaluate(() => {
      const region = document.querySelector(".editor-region");
      const tabBar = document.querySelector(".tab-bar");
      const computed = getComputedStyle(region);
      const regionRect = region.getBoundingClientRect();
      const tabBarRect = tabBar.getBoundingClientRect();
      return {
        padding: computed.padding,
        alignItems: computed.alignItems,
        justifyContent: computed.justifyContent,
        borderRightWidth: computed.borderRightWidth,
        borderRightStyle: computed.borderRightStyle,
        borderRightColor: computed.borderRightColor,
        regionX: regionRect.x,
        regionWidth: regionRect.width,
        tabBarX: tabBarRect.x,
        tabBarWidth: tabBarRect.width,
      };
    });
    // The 24px gutter and child-centering this card removes (#1369) — each band (tab strip,
    // toolbar, canvas) keeps its own padding instead.
    expect(layout.padding).toBe("0px");
    expect(layout.alignItems).toBe("normal");
    expect(layout.justifyContent).toBe("normal");
    // `specs/authoring-shell.md` §Layout: "1px #E3DFD6 right border" on the document column itself.
    expect(layout.borderRightWidth).toBe("1px");
    expect(layout.borderRightStyle).toBe("solid");
    expect(layout.borderRightColor).toBe("rgb(227, 223, 214)");

    // Dark-theme half of the same rule (#1369 review, `--color-editor-region-border` at
    // `src/styles.css:129`): `assertTabStrip` below already proves the Settings theme choice +
    // document-tab flow works in this file, so this reuses the same General Settings control.
    await chooseTheme(page, "Dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const darkBorder = await page.evaluate(
      () => getComputedStyle(document.querySelector(".editor-region")).borderRightColor,
    );
    expect(darkBorder).toBe("rgb(58, 61, 66)");

    // The tab strip's own box now starts flush with the region (files-rail-adjacent), matching hi-fi
    // 3a/3b, instead of sitting 24px inside it — the exact defect the issue's repro measured. Widths
    // differ by exactly the region's own 1px right border (border-box: the assigned width includes
    // it, so the content area — and the 100%-width tab strip inside it — is 1px narrower).
    expect(layout.tabBarX).toBe(layout.regionX);
    expect(layout.tabBarWidth).toBe(layout.regionWidth - 1);
  });

  test("UXR-Q13 swaps the 372px Timeline for a 400px comments rail with a one-row return control (#2535)", async ({ page }) => {
    await reportPlatform(page, "Win32");
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    await openDocument(page, project);
    const timeline = page.getByRole("region", { name: "Timeline" });
    const expandedWidth = await timeline.evaluate((element) => element.getBoundingClientRect().width);
    const editorWidth = await page.locator(".editor-region").evaluate((element) => element.getBoundingClientRect().width);
    expect(expandedWidth).toBe(372);

    await page.getByRole("button", { name: "Hide Timeline" }).click();
    await expect(timeline).toBeHidden();
    const comments = page.getByRole("region", { name: "Comments" });
    await expect(comments).toBeVisible();
    expect(await comments.evaluate((element) => element.getBoundingClientRect().width)).toBe(400);
    expect(await page.locator(".editor-region").evaluate((element) => element.getBoundingClientRect().width)).toBe(editorWidth - 28);
    await expect(page.getByRole("button", { name: "Show Timeline" })).toBeVisible();
    await expect(comments.getByText("No comments in this document")).toBeVisible();

    await page.setViewportSize({ width: 900, height: 700 });
    await expect(page.getByRole("button", { name: "More editor controls" })).toBeVisible();
    const row = await page.locator(".view-mode-toolbar:visible").evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        height: bounds.height,
        children: [...element.children].filter((child) => {
          const rect = child.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(child).position !== "fixed";
        }).map((child) => child.getBoundingClientRect().toJSON()),
      };
    });
    expect(row.height).toBeLessThan(50);
    expect(row.children.every((child) => child.y < row.children[0].y + 2)).toBe(true);

    const overflow = page.getByRole("button", { name: "More editor controls" });
    if (await overflow.isVisible()) await overflow.click();
    const returnControl = page.getByRole("button", { name: "Show Timeline" });
    await returnControl.focus();
    await returnControl.press("Enter");
    await expect(page.getByRole("textbox", { name: "Message" })).toBeFocused();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.getByRole("button", { name: "Hide Timeline" }).click();
    const editor = page.locator(".cm-content[role='textbox']:visible");
    await editor.focus();
    await page.getByRole("button", { name: "Show Timeline" }).click();
    await expect(editor).toBeFocused();

    await page.getByRole("button", { name: "Hide Timeline" }).click();
    await chooseTheme(page, "Dark");
    const darkColors = await comments.evaluate((element) => ({
      column: getComputedStyle(element).backgroundColor,
      surface: getComputedStyle(document.querySelector(".timeline-panel")).backgroundColor,
    }));
    expect(darkColors.column).toBe(darkColors.surface);
  });

  test("UXR-Q13 macOS uses the 400px comments-column fill and return chip (#2535)", async ({ page }) => {
    await reportPlatform(page, "MacIntel");
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    await openDocument(page, project);
    await page.getByRole("button", { name: "Hide Timeline" }).click();
    const comments = page.getByRole("region", { name: "Comments" });
    await expect(comments).toBeVisible();
    const appearance = await comments.evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      background: getComputedStyle(element).backgroundColor,
    }));
    expect(appearance).toEqual({ width: 400, background: "rgb(237, 234, 226)" });
    const chip = page.getByRole("button", { name: "Show Timeline" });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.getByRole("region", { name: "Timeline" })).toBeVisible();
  });

  test("CM6 caret and editor colors follow explicit and system theme changes on existing and newly mounted editors (#2392)", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await openDocument(page, project);
    const editor = page.locator(".cm-editor:visible");
    const content = editor.locator(".cm-content");
    await content.focus();

    const appearance = () =>
      editor.evaluate((element) => {
        const contentElement = element.querySelector(".cm-content");
        if (!contentElement) throw new Error("CM6 caret target is missing");
        return {
          editorColor: getComputedStyle(element).color,
          editorBackground: getComputedStyle(element).backgroundColor,
          contentCaret: getComputedStyle(contentElement).caretColor,
        };
      });
    const lightAppearance = {
      editorColor: "rgb(31, 29, 26)",
      editorBackground: "rgb(252, 251, 248)",
      contentCaret: "rgb(31, 29, 26)",
    };
    const darkAppearance = {
      editorColor: "rgb(230, 231, 234)",
      editorBackground: "rgb(30, 31, 34)",
      contentCaret: "rgb(230, 231, 234)",
    };

    await chooseTheme(page, "Light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect.poll(appearance).toEqual(lightAppearance);

    await chooseTheme(page, "Dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(appearance).toEqual(darkAppearance);

    await chooseTheme(page, "System");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect.poll(appearance).toEqual(lightAppearance);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect.poll(appearance).toEqual(darkAppearance);

    writeFileSync(join(project.root, "second.md"), "# Mounted after dark\n", "utf8");
    await page.evaluate(
      ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
      { root: project.root, path: "second.md" },
    );
    await expect(page.locator(".cm-content:visible")).toContainText("Mounted after dark");
    await expect.poll(appearance).toEqual(darkAppearance);
  });

  test("UXR-Q7.2 gives every file-backed authoring pane one fixed one-row status-bar shell", async ({
    page,
  }) => {
    await reportPlatform(page, "Win32");
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    await page.evaluate(
      ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
      { root: project.root, path: project.path },
    );
    await expect(page.locator(".cm-content")).toBeVisible();

    const status = page.getByRole("region", { name: "Document status" });
    await expect(status).toBeVisible();
    await expect(status).toContainText("Markdown");
    await expect(status).toContainText("2 words");
    await expect(status).not.toContainText("tracked change");
    await expect(status).not.toContainText("open comment");
    await expect(status).toContainText(/^Markdown/);
    await expect(status).toContainText(/Claude Code · /);
    const geometry = await page.evaluate(() => {
      const shell = document.querySelector(".editor-shell");
      const canvas = document.querySelector(".editor-shell__host");
      const bar = document.querySelector(".document-status-bar");
      const shellRect = shell.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      const computed = getComputedStyle(bar);
      return {
        platform: bar.getAttribute("data-platform"),
        top: barRect.top,
        bottom: barRect.bottom,
        canvasBottom: canvasRect.bottom,
        shellBottom: shellRect.bottom,
        width: barRect.width,
        shellWidth: shellRect.width,
        background: computed.backgroundColor,
        borderTopWidth: computed.borderTopWidth,
        borderTopColor: computed.borderTopColor,
        flexWrap: computed.flexWrap,
        whiteSpace: computed.whiteSpace,
      };
    });

    expect(geometry.platform).toBe("win");
    expect(geometry.top).toBe(geometry.canvasBottom);
    expect(geometry.bottom).toBe(geometry.shellBottom);
    expect(geometry.width).toBe(geometry.shellWidth);
    expect(geometry.background).toBe("rgb(245, 243, 237)");
    expect(geometry.borderTopWidth).toBe("1px");
    expect(geometry.borderTopColor).toBe("rgb(227, 223, 214)");
    expect(geometry.flexWrap).toBe("nowrap");
    expect(geometry.whiteSpace).toBe("nowrap");
  });

  test("B6 keeps tracked-change status within narrow document columns", async ({ page }) => {
    const changed = createFixtureProject("Hello {++brave ++}world\n");
    try {
      await reportPlatform(page, "Win32");
      await page.goto("/");
      await openDocument(page, changed);
      const status = page.getByRole("region", { name: "Document status" });
      await expect(status).toContainText("1 tracked change");

      for (const width of [825, 760]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(status.getByRole("button", { name: "More document status" })).toBeVisible();
        const geometry = await status.evaluate((bar) => {
          const leading = bar.querySelector(".document-status-bar__leading");
          const overflow = bar.querySelector(".document-status-bar__overflow > button");
          return {
            barScrollWidth: bar.scrollWidth,
            barClientWidth: bar.clientWidth,
            leadingRight: leading.getBoundingClientRect().right,
            overflowLeft: overflow.getBoundingClientRect().left,
            overflowRight: overflow.getBoundingClientRect().right,
            barRight: bar.getBoundingClientRect().right,
            whiteSpace: getComputedStyle(bar).whiteSpace,
          };
        });
        expect(geometry.barScrollWidth).toBeLessThanOrEqual(geometry.barClientWidth);
        expect(geometry.leadingRight).toBeLessThan(geometry.overflowLeft);
        expect(geometry.overflowRight).toBeLessThan(geometry.barRight);
        expect(geometry.whiteSpace).toBe("nowrap");
        await expect(
          status.getByRole("group", { name: "Markdown · 3 words · 1 tracked change" }),
        ).toHaveAttribute("title", "Markdown · 3 words · 1 tracked change");
        await expect(status.locator('[data-status-item-id="tracked-change-count"]')).toHaveAttribute(
          "aria-label",
          "1 tracked change",
        );
      }
    } finally {
      await changed.cleanup(page);
    }
  });

  test("D5 General theme chooser works by keyboard and persists across reload", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await openDocument(page, project);
    const title = page.locator(".app-header");
    expect(await title.getByRole("group", { name: "Theme" }).count()).toBe(0);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Settings" });
    const content = dialog.locator(".settings-dialog__content");
    await expect(content.locator(":scope > :first-child")).toHaveClass(/settings-dialog__row/);
    await expect(content.getByRole("heading", { name: "General" })).toHaveCount(0);
    const themeTopInset = await content.evaluate((element) => {
      const row = element.querySelector(".settings-dialog__row");
      if (!row) throw new Error("Theme row missing from General content");
      return row.getBoundingClientRect().top - element.getBoundingClientRect().top;
    });
    expect(themeTopInset).toBe(20);
    const theme = dialog.getByRole("group", { name: "Theme" });
    await expect(theme).toBeVisible();
    await expect(theme.getByRole("button", { name: "System" })).toHaveAttribute("aria-pressed", "true");
    await theme.getByRole("button", { name: "Dark" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(theme.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");
    await dialog.getByRole("button", { name: "Close Settings" }).click();

    await page.reload();
    await openDocument(page, project);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog.getByRole("group", { name: "Theme" }).getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "true");

    await dialog.getByRole("button", { name: "System" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("Settings UI persists autosave and reveal preferences through reload via production callers (#1832, #2389)", async ({
    page,
  }) => {
    await page.goto("/");
    await openDocument(page, project);
    const editor = visibleEditor(page);
    await expect(editor.locator(".cm-markupHidden")).toHaveCount(1);
    await expect(editor.locator(".cm-markupRevealed")).toHaveCount(0);
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Settings" });
    const reveal = dialog.getByRole("checkbox", { name: "Reveal markup at cursor" });
    const interval = dialog.getByRole("combobox", { name: "Autosave interval" });
    await expect(reveal).not.toBeChecked();
    await expect(interval).toHaveValue("1000");
    await interval.selectOption("2000");
    await expect(dialog.getByRole("status", { name: "Settings save status" })).toHaveText("Settings saved");
    await reveal.check();
    await expect(dialog.getByRole("status", { name: "Settings save status" })).toHaveText("Settings saved");
    await expect(editor.locator(".cm-markupRevealed")).toHaveCount(1);

    // A full browser reload destroys the dialog and every React-owned value. Reopening Settings
    // can show both non-default values only if the first surface called production `patchSettings`
    // and this fresh one called production `getSettings`; D23 substitutes only their transport.
    await page.reload();
    await openDocument(page, project);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const reloadedDialog = page.getByRole("dialog", { name: "Settings" });
    const reloadedReveal = reloadedDialog.getByRole("checkbox", {
      name: "Reveal markup at cursor",
    });
    const reloadedInterval = reloadedDialog.getByRole("combobox", { name: "Autosave interval" });
    await expect(reloadedReveal).toBeChecked();
    await expect(reloadedInterval).toHaveValue("2000");
    await expect(visibleEditor(page).locator(".cm-markupRevealed")).toHaveCount(1);

    // This driver process is shared by the serial acceptance suite. Return its real settings store
    // to the default through the same user surface so no later scenario inherits this fixture.
    await reloadedReveal.uncheck();
    await expect(reloadedDialog.getByRole("status", { name: "Settings save status" })).toHaveText("Settings saved");
    await reloadedInterval.selectOption("1000");
    await expect(reloadedDialog.getByRole("status", { name: "Settings save status" })).toHaveText("Settings saved");
  });

  test("voice Settings keyboard toggle persists through reload via the typed backend (#2547)", async ({ page }) => {
    await page.goto("/");
    await openDocument(page, project);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Settings" });
    let enabled = dialog.getByRole("switch", { name: "Enable voice" });
    await expect(enabled).toBeChecked();
    await expect(dialog.getByText("Model not downloaded")).toBeVisible();
    await enabled.focus();
    await page.keyboard.press("Space");
    await expect(enabled).not.toBeChecked();

    await page.reload();
    await openDocument(page, project);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Settings" });
    enabled = dialog.getByRole("switch", { name: "Enable voice" });
    await expect(enabled).not.toBeChecked();
    await enabled.focus();
    await page.keyboard.press("Space");
    await expect(enabled).toBeChecked();
  });

  test("fake-agent handshake: spawning a P0-6 scenario connects and round-trips", async () => {
    // Unlike every other case in this file, this one's wall-clock cost is a `cargo run` subprocess
    // spawn (`fakeAgent.mjs`), not a DOM/scroll settle — its duration tracks the shared
    // `src-tauri/target` build/lock state, which a concurrent `cargo` invocation elsewhere on the
    // box can stretch far past its ordinary ~2s (measured 54s once, coincident with unrelated
    // concurrent cargo activity in this same worktree, and a further 2.2s-to-15.7s swing observed
    // on a warm target at low load — spawn cost here is inherently variable, not a fixed offset).
    // The default 30s suite timeout leaves that no margin, which is one of #1317's two reported
    // failure sites (macOS full-suite runs, load average ~11). This is the same class of work the
    // neighbouring `test-driver` webServer budgets 120_000 for below ("First run compiles the
    // crate; can be slow on a cold cache") — a cold or contended `src-tauri/target` compiles here
    // too, so this test is held to that same cold-compile margin rather than a thinner one.
    test.setTimeout(120_000);
    // The MCP server itself doesn't exist yet (P2a-12) — this exercises the fake agent (P0-6/P0-7)
    // directly, the same way a real provider adapter will once it's wired in: spawn, read the
    // stream-JSON handshake, confirm the round-trip completed successfully.
    const events = await runFakeAgentScenario("claude-minimal-success.json");

    const init = events.find((event) => event.type === "system" && event.subtype === "init");
    expect(init).toBeTruthy();
    expect(init.mcp_servers).toContainEqual({ name: "emend", status: "connected" });

    const last = events.at(-1);
    expect(last.type).toBe("result");
    expect(last.subtype).toBe("success");
  });

  test("fixture teardown closes the page and backend project before removing its directory", async ({
    page,
  }) => {
    await page.goto("/");
    await openDocument(page, project);

    await project.cleanup(page);

    expect(page.isClosed()).toBe(true);
    expect(existsSync(project.root)).toBe(false);
    await expect(post("refresh_project_files", {})).rejects.toThrow(
      'refresh_project_files failed: {"kind":"ProjectUnavailable","message":"no project is open"}',
    );
  });
});

test.describe("D27 retained legacy unsupported-tab recovery", () => {
  /** @type {ReturnType<typeof createFixtureProject>} */
  let project;

  test.afterEach(async ({ page }) => {
    await project.cleanup(page);
  });

  test("D27 restores unsupported retained text as untitled and adopts it without writing the former file", async ({ page }) => {
    project = createFixtureProject("# Supported document\n");
    const formerPath = project.addFile("draft.rs", "original source\n");
    const retained = "retained \u00e9dit\r\nsecond line\r\n";
    const recoveryPath = `untitled:1:${formerPath}`;
    const sessionPath = join(project.root, ".emend", "tab-session.json");
    mkdirSync(join(project.root, ".emend"), { recursive: true });
    writeFileSync(sessionPath, JSON.stringify({
      schema_version: 1,
      tabs: [{ path: formerPath, unsaved_content: retained }],
      active_path: formerPath,
    }));

    await page.goto("/");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    await expect(page.getByRole("tab", { name: /Untitled — recovered from draft\.rs, editable/ })).toBeVisible();
    await expect(page.locator(".app-header__title")).toHaveText(
      `${process.platform === "darwin" ? "" : "Emend — "}Untitled — from draft.rs`,
    );
    const sourceNotice = page.getByRole("region", { name: "Unsupported document recovery notice" });
    await expect(sourceNotice).toContainText("The unsaved text this tab held is here, in an untitled document you can edit.");
    await expect(sourceNotice).toContainText("not to the original file");
    await expect(page.locator(".shell-status")).toContainText(
      "Its retained text is editable in an untitled tab; use Save As",
    );
    await expect(page.getByRole("textbox", { name: "Untitled document text" })).toContainText("retained \u00e9dit");
    await expect.poll(() => {
      const session = JSON.parse(readFileSync(sessionPath, "utf8"));
      return session.tabs.find((tab) => tab.path === recoveryPath)?.unsaved_content;
    }).toBe(retained);
    expect(project.readSaved(formerPath)).toBe("original source\n");
    await expect(page.getByRole("treeitem", { name: formerPath })).toHaveCount(0);

    await page.reload();
    // Startup hydration reads the backend's current canonical root and restores the session.
    // Re-routing a folder already open here would only produce an "already open" status.
    await expect(page.getByRole("tab", { name: /Untitled — recovered from draft\.rs, editable/ })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Untitled document text" })).toContainText("second line");
    await expect(page.getByRole("region", { name: "Unsupported document recovery notice" })).toBeVisible();

    const boundRoot = await post("current_project", {});
    // Windows startup can report an extended canonical root, while its native panel returns the
    // ordinary drive/UNC spelling. Exercise that real Save As boundary after hydration.
    const pickedRoot = process.platform === "win32"
      ? boundRoot.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "").toLowerCase()
      : boundRoot;
    await page.evaluate(
      (destination) => window.__EMEND_E2E__?.setNextSaveAsDialogResult(destination),
      join(pickedRoot, "recovered.md"),
    );
    await page.getByRole("button", { name: "Save As…" }).click();
    await expect(page.getByRole("tab", { name: "recovered.md" })).toBeVisible();
    await expect(page.locator(".app-header__title")).toHaveText(
      `${process.platform === "darwin" ? "" : "Emend — "}recovered.md`,
    );
    await expect(page.getByRole("region", { name: "Unsupported document recovery notice" })).toHaveCount(0);
    await expect.poll(() => project.readSaved("recovered.md")).toBe(retained);
    expect(project.readSaved(formerPath)).toBe("original source\n");
  });

  test("D27 keeps the omission-only unsupported tab's visible loss marker after refusal dismissal", async ({ page }) => {
    project = createFixtureProject("# Supported document\n");
    mkdirSync(join(project.root, "research"), { recursive: true });
    const formerPath = project.addFile("research/survey-export.csv", "source rows\n");
    const sessionPath = join(project.root, ".emend", "tab-session.json");
    mkdirSync(join(project.root, ".emend"), { recursive: true });
    writeFileSync(sessionPath, JSON.stringify({
      schema_version: 1,
      tabs: [{ path: formerPath, unsaved_content: null, unsaved_content_omitted: true }],
      active_path: formerPath,
    }));

    await page.goto("/");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    const tab = page.getByRole("tab", {
      name: `${formerPath} — earlier unsaved work was not preserved`,
    });
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute("data-recovery-content-omitted", "true");
    await expect(tab.locator(".tab-bar__recovery-dot")).toBeVisible();
    await expect(page.locator(".shell-status--unsupported-refusal")).toBeVisible();
    await page.locator(".shell-status--unsupported-refusal .shell-status__dismiss").click();
    await expect(page.locator(".shell-status--unsupported-refusal")).toHaveCount(0);
    await expect(tab.locator(".tab-bar__recovery-dot")).toBeVisible();
    expect(project.readSaved(formerPath)).toBe("source rows\n");
  });
});

test.describe("J2 recovered document over-cap state (#1421)", () => {
  /** @type {ReturnType<typeof createFixtureProject>} */
  let project;

  test.afterEach(async ({ page }) => {
    await project.cleanup(page);
  });

  test("9c loss reason follows the 660px short-copy tile and keeps its caution at narrower widths", async ({ page }) => {
    project = createFixtureProject("# The moved document now at this path\n");
    const recoveryPath = `untitled:1:${project.path}`;
    const emendDir = join(project.root, ".emend");
    mkdirSync(emendDir, { recursive: true });
    writeFileSync(
      join(emendDir, "tab-session.json"),
      JSON.stringify({
        schema_version: 1,
        tabs: [{
          path: recoveryPath,
          unsaved_content: null,
          recovered_from: project.path,
          unsaved_content_omitted: true,
          loss_notice_collapsed: false,
        }],
        active_path: recoveryPath,
      }),
    );

    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    await page.evaluate(
      ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
      { root: project.root, path: recoveryPath },
    );
    const pane = page.locator(".untitled-document");
    const notice = page.getByRole("region", {
      name: `Recovery notice, untitled document from ${project.path}`,
    });
    const reason = notice.locator(".untitled-document__loss-reason");
    await expect(notice).toBeVisible();
    await expect(reason).toContainText("This untitled tab holds work from");
    await expect(reason).toContainText("You can edit this untitled document");

    const sideWidth = await page.evaluate(() =>
      document.querySelector(".project-rail").getBoundingClientRect().width
      + document.querySelector(".timeline-panel").getBoundingClientRect().width,
    );
    for (const paneWidth of [660, 420, 330]) {
      await page.setViewportSize({ width: Math.round(sideWidth + paneWidth + 1), height: 900 });
      await expect.poll(async () => Math.abs(
        (await pane.evaluate((element) => element.getBoundingClientRect().width)) - paneWidth,
      )).toBeLessThanOrEqual(0.25);
      if (paneWidth <= 420) {
        const copyBottom = await notice.locator(".untitled-document__loss-copy")
          .evaluate((element) => element.getBoundingClientRect().bottom);
        const toggleTop = await notice.getByRole("button", { name: "Hide message" })
          .evaluate((element) => element.getBoundingClientRect().top);
        expect(toggleTop).toBeGreaterThanOrEqual(copyBottom);
      }
      const visibleCopy = (await reason.evaluate((element) => element.innerText))
        .replace(/\s+/g, " ").trim();
      expect(visibleCopy).toMatch(/^An earlier unsaved buffer was larger than/);
      expect(visibleCopy).toContain("You can write here; Save As… adds the current text to the project.");
      expect(visibleCopy).toMatch(/It doesn’t bring back what wasn’t kept\.$/);
      expect(visibleCopy).not.toContain("This untitled tab holds work from");
      expect(visibleCopy).not.toContain("You can edit this untitled document");
    }
  });

  test("9c stays explicit and collapsed across a real session relaunch, then uses truthful empty and edited guards", async ({
    page,
  }) => {
    project = createFixtureProject("# The moved document now at this path\n");
    const recoveryPath = `untitled:1:${project.path}`;
    const emendDir = join(project.root, ".emend");
    const sessionPath = join(emendDir, "tab-session.json");
    mkdirSync(emendDir, { recursive: true });
    writeFileSync(
      sessionPath,
      JSON.stringify({
        schema_version: 1,
        tabs: [
          {
            path: recoveryPath,
            unsaved_content: null,
            recovered_from: project.path,
            unsaved_content_omitted: true,
            loss_notice_collapsed: false,
          },
        ],
        active_path: recoveryPath,
      }),
    );

    await page.goto("/");
    await page.evaluate(
      ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
      { root: project.root, path: recoveryPath },
    );

    const recoveryName = `Untitled — recovered from ${project.path}, editable — earlier unsaved work was not preserved`;
    await expect(page.getByRole("tab", { name: recoveryName })).toBeVisible();
    await expect(
      page.getByRole("region", {
        name: `Recovery notice, untitled document from ${project.path}`,
      }),
    ).toContainText(
      "Your earlier unsaved work couldn’t be preserved.",
    );
    await expect(page.getByRole("textbox", { name: "Untitled document text" })).toHaveAttribute(
      "aria-placeholder",
      "Nothing was recovered into this document — you can start writing here.",
    );

    await page.getByRole("button", { name: "Hide message" }).click();
    await expect(
      page.getByRole("button", { name: "Earlier unsaved work not preserved — show details" }),
    ).toBeVisible();
    await expect
      .poll(() => JSON.parse(readFileSync(sessionPath, "utf8")).tabs[0].loss_notice_collapsed)
      .toBe(true);

    await page.reload();
    await page.evaluate(
      ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
      { root: project.root, path: recoveryPath },
    );
    await expect(
      page.getByRole("button", { name: "Earlier unsaved work not preserved — show details" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Earlier unsaved work not preserved — show details" })
      .click();
    await page.getByRole("button", { name: `Close ${recoveryName}` }).click();

    let guard = page.getByRole("alertdialog");
    await expect(guard).toContainText(
      "This untitled document is empty now. Earlier unsaved work was not preserved. Closing it discards no current content.",
    );
    await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(page.getByRole("button", { name: "Discard this untitled document" })).toHaveCSS(
      "background-color",
      "rgb(255, 255, 255)",
    );
    await page.getByRole("button", { name: "Cancel" }).click();

    await page.getByRole("textbox", { name: "Untitled document text" }).fill("new work");
    await page.getByRole("button", { name: `Close ${recoveryName}` }).click();
    guard = page.getByRole("alertdialog");
    await expect(guard).toContainText(
      "You've written in this document since it was opened, and that work isn't saved anywhere.",
    );
    await expect(page.getByRole("button", { name: "Discard this untitled document" })).toHaveCSS(
      "background-color",
      "rgb(163, 58, 46)",
    );
  });
});

test.describe("D12 untitled comment adoption (#1803)", () => {
  /** @type {ReturnType<typeof createFixtureProject>} */
  let project;

  test.afterEach(async ({ page }) => {
    await project.cleanup(page);
  });

  test("an untitled comment survives Save As and a real browser/session reload", async ({ page }) => {
    const content = "Hello untitled comment\n";
    const recoveryPath = "untitled:1:notes.md";
    const destination = "adopted.md";
    project = createFixtureProject("# The moved document now at this path\n");
    const emendDir = join(project.root, ".emend");
    const sessionPath = join(emendDir, "tab-session.json");
    mkdirSync(emendDir, { recursive: true });
    writeFileSync(sessionPath, JSON.stringify({
      schema_version: 1,
      tabs: [{
        path: recoveryPath,
        unsaved_content: content,
        recovered_from: project.path,
      }],
      active_path: recoveryPath,
    }));

    await page.goto("/");
    await page.evaluate(
      ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
      { root: project.root, path: recoveryPath },
    );
    const editor = page.getByRole("textbox", { name: "Untitled document text" });
    await expect(editor).toHaveText(content.trim());

    // The selection affordance cannot appear until the backend UUID has been minted and its
    // session checkpoint acknowledged. Driving it here therefore crosses the real durability
    // fence before the first sidecar write rather than seeding a sidecar out of band.
    await editor.focus();
    await page.keyboard.press(`${mod}+Home`);
    for (let i = 0; i < 5; i += 1) await page.keyboard.press("Shift+ArrowRight");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    const composer = page.getByRole("dialog", { name: "New comment" });
    await composer.getByLabel("Comment").fill("This follows the untitled document.");
    await composer.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.locator(".cm-commentHighlight", { hasText: "Hello" })).toBeVisible();

    // J10's pathless correction must use the same minted document ID before Save As moves it.
    await page.locator(".cm-commentHighlight", { hasText: "Hello" }).click();
    const correction = page.getByRole("dialog", { name: "Comment thread" });
    await correction.getByRole("button", { name: "Edit comment" }).click();
    await correction.getByRole("textbox", { name: "Edit comment body" }).fill("Revised while untitled.");
    await correction.getByRole("button", { name: "Save", exact: true }).click();
    await expect(correction).toContainText("Revised while untitled.");
    await page.keyboard.press("Escape");

    await page.evaluate(
      (path) => window.__EMEND_E2E__?.setNextSaveAsDialogResult(path),
      join(project.root, destination),
    );
    await page.getByRole("button", { name: "Save As…" }).click();
    await expect(page.getByRole("tab", { name: destination })).toBeVisible();
    await expect.poll(() => readFileSync(join(project.root, destination), "utf8")).toBe(content);
    await expect(page.locator('[data-card-kind="untitled-adoption"]')).toContainText(
      `Untitled saved as ${destination} — 1 comment moved with it.`,
    );
    expect((await loadCommentThreads(project.root, destination)).map((thread) => thread.body)).toContain(
      "Revised while untitled.",
    );

    await page.reload();
    await page.evaluate(
      ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
      { root: project.root, path: destination },
    );
    const restoredHighlight = page.locator(".cm-commentHighlight", { hasText: "Hello" });
    await expect(restoredHighlight).toBeVisible();
    await restoredHighlight.click();
    await expect(page.getByRole("dialog", { name: "Comment thread" })).toContainText(
      "Revised while untitled.",
    );
    await expect(page.locator('[data-card-kind="untitled-adoption"]')).toHaveCount(1);
  });
});

test.describe("D23 representative long-form authoring baseline", () => {
  // These three cases are the suite's heaviest by design (test-plan §4/D23): multiple viewport
  // resizes, full-document scroll/reflow over real corpus-sized files, typed edits with undo/redo,
  // and tab-restore round trips. Measured against the default 30s suite timeout at ambient load
  // average ~10–11 (the concurrent development load observed in #1317), all three already
  // ran 20.0–22.7s — 67–76% of the budget consumed by real, necessary work before any additional
  // load. That is the reported flake's mechanism, not a hang: widened here to a measured ~4x margin
  // over that observed cost, scoped to this describe block only so every other (fast) case keeps
  // its original sensitivity to a genuine stall (#1317).
  test.describe.configure({ timeout: 90_000 });

  /** @type {ReturnType<typeof createCorpusFixtureProject>} */
  let project;

  test.afterEach(async ({ page }) => {
    await project.cleanup(page);
  });

  test("representative documents wrap without page overflow and expose both boundaries through user navigation at desktop and narrow viewports", async ({
    page,
  }) => {
    project = createCorpusFixtureProject("collectedDiscourses", [
      "apiReference",
      "rustDataTypes",
    ]);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openDocument(page, project);

    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 760, height: 700 },
    ]) {
      await page.setViewportSize(viewport);
      await goToDocumentBoundary(page, "start");

      const host = visibleScrollHost(page);
      const firstLine = host.locator(".cm-line").first();
      await expect(firstLine).toContainText("Collected Discourses");
      await expectLineInsideHost(firstLine, host);

      const wrappedProse = host
        .locator(".cm-line")
        .filter({ hasText: "A gathering of short addresses on work" })
        .first();
      await expect(wrappedProse).toBeVisible();
      if (viewport.width === 760) {
        const wraps = await wrappedProse.evaluate((line) => {
          const lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight);
          return line.getBoundingClientRect().height > lineHeight * 1.5;
        });
        expect(wraps).toBe(true);
      }

      const pageOverflow = await page.evaluate(() => {
        const overflowing = [...document.querySelectorAll("*")]
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              className: element.className,
              nodeName: element.nodeName,
              right: rect.right,
              width: rect.width,
            };
          })
          .filter(({ right }) => right > window.innerWidth + 1)
          .slice(0, 12);
        return {
          overflowing,
          root: document.documentElement.scrollWidth - window.innerWidth,
          scrollX: window.scrollX,
        };
      });
      expect(pageOverflow.root, JSON.stringify(pageOverflow.overflowing)).toBeLessThanOrEqual(1);
      expect(pageOverflow.scrollX).toBe(0);
      const appBox = await page.locator(".app-shell").boundingBox();
      expect(appBox).not.toBeNull();
      expect(appBox.x).toBeGreaterThanOrEqual(0);
      expect(appBox.x + appBox.width).toBeLessThanOrEqual(viewport.width);
      const hostMetrics = await scrollMetrics(host);
      expect(hostMetrics.scrollWidth - hostMetrics.clientWidth).toBeLessThanOrEqual(1);

      const hostBox = await host.boundingBox();
      expect(hostBox).not.toBeNull();
      await page.mouse.move(hostBox.x + 20, hostBox.y + hostBox.height / 2);
      await page.mouse.wheel(0, viewport.height);
      await expect.poll(() => host.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await goToDocumentBoundary(page, "end");
      await goToDocumentBoundary(page, "start");
    }

    const rustPath = project.fixturePath("rustDataTypes");
    await openDocument(page, project, rustPath);
    await goToDocumentBoundary(page, "end");
    const rustHost = visibleScrollHost(page);
    const longReference = rustHost
      .locator(".cm-line")
      .filter({ hasText: /^\[comparing-the-guess-to-the-secret-number\]/ });
    await expect(longReference).toBeVisible();
    const endScrollTop = await rustHost.evaluate((element) => element.scrollTop);
    const referenceBox = await longReference.boundingBox();
    const referenceHostBox = await rustHost.boundingBox();
    expect(referenceBox).not.toBeNull();
    expect(referenceHostBox).not.toBeNull();
    // The end-caret follow yields to a user's wheel input, not a locator's programmatic scroll.
    await rustHost.hover();
    await page.mouse.wheel(
      0,
      Math.round(
        referenceBox.y + referenceBox.height / 2 -
        referenceHostBox.y - referenceHostBox.height / 2,
      ),
    );
    await expect.poll(() => rustHost.evaluate((element) => element.scrollTop))
      .toBeLessThan(endScrollTop - 100);
    await expectLineInsideHost(longReference, rustHost);
    const longReferenceGeometry = await longReference.evaluate((line) => {
      const lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight);
      const host = line.closest(".editor-shell__host");
      return {
        hostWidth: host?.clientWidth ?? 0,
        lineHeight,
        renderedHeight: line.getBoundingClientRect().height,
        renderedWidth: line.getBoundingClientRect().width,
      };
    });
    expect(longReferenceGeometry.renderedHeight).toBeGreaterThan(
      longReferenceGeometry.lineHeight * 1.5,
    );
    expect(longReferenceGeometry.renderedWidth).toBeLessThanOrEqual(
      longReferenceGeometry.hostWidth,
    );
    const narrowOverflow = await page.evaluate(() => ({
      root: document.documentElement.scrollWidth - window.innerWidth,
      scrollX: window.scrollX,
    }));
    expect(narrowOverflow.root).toBeLessThanOrEqual(1);
    expect(narrowOverflow.scrollX).toBe(0);
  });

  test("representative prose reflows with a live caret -> accepts beginning middle and end edits with undo redo -> saves only those edits", async ({
    page,
  }) => {
    const beginningEdit = "BEGIN_809::";
    const middleEdit = "MIDDLE_809::-AFTER-REFLOW";
    const endEdit = "END_809::";
    project = createCorpusFixtureProject("collectedDiscourses");
    const original = project.originalText("collectedDiscourses");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(3_600_000));
    await openDocument(page, project);

    const editor = visibleEditor(page);
    const host = visibleScrollHost(page);
    await editor.focus();
    await page.keyboard.press(`${mod}+Home`);
    await page.keyboard.type(beginningEdit);

    await pageDownToFraction(page, 0.45);
    await clickViewportCenterLine(host);
    await page.keyboard.type("MIDDLE_809::");
    await expect(editor).toContainText("MIDDLE_809::");
    await page.keyboard.press(`${mod}+z`);
    await expect(editor).not.toContainText("MIDDLE_809::");
    await page.keyboard.press(redo);
    await expect(editor).toContainText("MIDDLE_809::");

    const scrollBeforeReflow = await host.evaluate((element) => element.scrollTop);
    expect(scrollBeforeReflow).toBeGreaterThan(0);
    await page.setViewportSize({ width: 760, height: 700 });
    await expect
      .poll(() => host.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(editor).toBeFocused();
    await page.keyboard.type("-AFTER-REFLOW");
    await expect(editor).toContainText(middleEdit);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      ),
    ).toBeLessThanOrEqual(1);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect
      .poll(() => host.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await expect(editor).toBeFocused();
    await goToDocumentBoundary(page, "end");
    await page.keyboard.type(endEdit);
    await goToDocumentBoundary(page, "start");
    await goToDocumentBoundary(page, "end");
    await page.keyboard.press(`${mod}+s`);

    await expect.poll(() => project.readSaved()).toContain(endEdit);
    const saved = project.readSaved();
    for (const edit of [beginningEdit, middleEdit, endEdit]) {
      expect(saved.split(edit)).toHaveLength(2);
    }
    expect(
      saved
        .replace(beginningEdit, "")
        .replace(middleEdit, "")
        .replace(endEdit, ""),
    ).toBe(original);

    expect(saved.indexOf(beginningEdit)).toBeLessThan(saved.length * 0.05);
    expect(saved.indexOf(middleEdit)).toBeGreaterThan(saved.length * 0.3);
    expect(saved.indexOf(middleEdit)).toBeLessThan(saved.length * 0.7);
    expect(saved.indexOf(endEdit)).toBeGreaterThan(saved.length * 0.95);

    const tailBeforeWheel = await host.evaluate((element) => element.scrollTop);
    await host.hover();
    await page.mouse.wheel(0, -420);
    await expect.poll(() => host.evaluate((element) => element.scrollTop))
      .toBeLessThan(tailBeforeWheel - 40);
  });

  test("representative tabs restore independent caret and scroll state and Markdown preserves the active long-document neighborhood and boundaries", async ({
    page,
  }) => {
    const proseMarker = "PROSE_CURSOR_809::";
    const technicalMarker = "TECH_CURSOR_809::";
    project = createCorpusFixtureProject("collectedDiscourses", ["apiReference"]);

    await page.setViewportSize({ width: 1100, height: 760 });
    await page.goto("/");
    await page.evaluate(() =>
      window.__EMEND_E2E__?.setAutosaveIntervalMs(3_600_000),
    );
    await openDocument(page, project);

    const proseTab = page.getByRole("tab", { name: project.path, exact: false });
    await pageDownToFraction(page, 0.25);
    await clickViewportCenterLine(visibleScrollHost(page));
    await page.keyboard.type(proseMarker);
    await expect(visibleEditor(page)).toContainText(proseMarker);
    await page.keyboard.press(`${mod}+s`);
    await expect.poll(() => project.readSaved()).toContain(proseMarker);
    const proseMetrics = await scrollMetrics(visibleScrollHost(page));
    const proseScroll = proseMetrics.scrollTop;
    const proseFraction = proseScroll / (proseMetrics.scrollHeight - proseMetrics.clientHeight);
    expect(proseScroll).toBeGreaterThan(0);

    const technicalPath = project.fixturePath("apiReference");
    await openDocument(page, project, technicalPath);
    const technicalTab = page.getByRole("tab", { name: technicalPath, exact: false });
    await pageDownToFraction(page, 0.65);
    await clickViewportCenterLine(visibleScrollHost(page));
    await page.keyboard.type(technicalMarker);
    await expect(visibleEditor(page)).toContainText(technicalMarker);
    await page.keyboard.press(`${mod}+s`);
    await expect.poll(() => project.readSaved(technicalPath)).toContain(technicalMarker);
    const technicalMetrics = await scrollMetrics(visibleScrollHost(page));
    const technicalScroll = technicalMetrics.scrollTop;
    const technicalFraction =
      technicalScroll / (technicalMetrics.scrollHeight - technicalMetrics.clientHeight);
    expect(technicalScroll).toBeGreaterThan(0);
    expect(technicalScroll).not.toBe(proseScroll);

    await proseTab.click();
    await expect
      .poll(() => visibleScrollHost(page).evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    const restoredProseMetrics = await scrollMetrics(visibleScrollHost(page));
    const restoredProseFraction =
      restoredProseMetrics.scrollTop /
      (restoredProseMetrics.scrollHeight - restoredProseMetrics.clientHeight);
    expect(Math.abs(restoredProseFraction - proseFraction)).toBeLessThan(0.08);
    await visibleEditor(page).focus();
    await page.keyboard.type("-RESTORED");
    await page.keyboard.press(`${mod}+s`);
    await expect.poll(() => project.readSaved()).toContain(`${proseMarker}-RESTORED`);

    const sourceScroll = await visibleScrollHost(page).evaluate((element) => element.scrollTop);
    await page.getByRole("button", { name: "Markdown" }).click();
    await expect
      .poll(() => visibleScrollHost(page).evaluate((element) => element.scrollTop))
      .toBe(sourceScroll);
    await visibleEditor(page).focus();
    await page.keyboard.type("-SOURCE-STABLE");
    await page.keyboard.press(`${mod}+s`);
    await expect
      .poll(() => project.readSaved())
      .toContain(`${proseMarker}-RESTORED-SOURCE-STABLE`);
    await goToDocumentBoundary(page, "end");
    await goToDocumentBoundary(page, "start");

    await technicalTab.click();
    await expect
      .poll(() => visibleScrollHost(page).evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    const restoredTechnicalMetrics = await scrollMetrics(visibleScrollHost(page));
    const restoredTechnicalFraction =
      restoredTechnicalMetrics.scrollTop /
      (restoredTechnicalMetrics.scrollHeight - restoredTechnicalMetrics.clientHeight);
    expect(Math.abs(restoredTechnicalFraction - technicalFraction)).toBeLessThan(0.08);
    await visibleEditor(page).focus();
    await page.keyboard.type("-RESTORED");
    await page.keyboard.press(`${mod}+s`);
    await expect
      .poll(() => project.readSaved(technicalPath))
      .toContain(`${technicalMarker}-RESTORED`);
  });
});

test.describe("P2a-6 tabs, session restore, dirty-close guard", () => {
  /** @type {ReturnType<typeof createFixtureProject>} */
  let project;
  /** @type {string} */
  let secondPath;

  test.beforeEach(() => {
    project = createFixtureProject("# First doc\n");
    secondPath = project.addFile("second.md", "# Second doc\n");
  });

  test.afterEach(async ({ page }) => {
    await project.cleanup(page);
  });

  async function openTab(page, path) {
    await page.evaluate(
      ({ root, path: p }) => window.__EMEND_E2E__?.openProject(root, p),
      { root: project.root, path },
    );
  }

  // This journey asserts a tab stays *dirty and unsaved* across a multi-step interaction (type ->
  // switch tabs -> switch back -> assert). The always-on autosave (P2a-7, 1 s debounce) would
  // otherwise write to disk and clear dirty mid-scenario if the steps spent >1 s of wall time —
  // exactly the wall-clock race test-plan §7 forbids. Pausing autosave (a large interval) makes the
  // dirty window deterministic; it must be re-set after any reload, which rebuilds the page global.
  // Set it *before* opening a tab, since the editor reads the interval when it arms its scheduler.
  async function pauseAutosave(page) {
    await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(3_600_000));
  }

  test("open two tabs -> switch preserves each tab's state -> reload restores the session incl. unsaved content -> dirty-close guard (cancel then save)", async ({
    page,
  }) => {
    await page.goto("/");
    await pauseAutosave(page);

    // Opening a second file opens a second tab, not a replacement of the first (FR-ED-3).
    await openTab(page, project.path);
    await expect(page.locator(".cm-content:visible")).toContainText("First doc");
    await openTab(page, secondPath);
    await expect(page.getByRole("tab", { name: project.path, exact: false })).toBeVisible();
    await expect(page.getByRole("tab", { name: secondPath, exact: false })).toBeVisible();
    await expect(page.locator(".cm-content:visible")).toContainText("Second doc");

    // Type into the (now active) second tab, without saving — an unsaved, dirty edit.
    const unsavedAddition = "an in-flight edit nobody saved yet";
    await page.locator(".cm-content:visible").click();
    await page.keyboard.press(`${mod}+End`);
    await page.keyboard.type(`\n\n${unsavedAddition}`);
    await expect(
      page.getByRole("tab", { name: secondPath, exact: false }).locator(".tab-bar__dot"),
    ).toBeVisible();

    // Switching tabs preserves each tab's own editor state: the first tab still shows its
    // original (never-touched) content, and coming back to the second still shows the edit.
    await page.getByRole("tab", { name: project.path, exact: false }).click();
    await expect(page.locator(".cm-content:visible")).toContainText("First doc");
    await expect(page.locator(".cm-content:visible")).not.toContainText(unsavedAddition);
    await page.getByRole("tab", { name: secondPath, exact: false }).click();
    await expect(page.locator(".cm-content:visible")).toContainText(unsavedAddition);

    // The dirty edit was never saved — the file on disk is still exactly what it started as.
    expect(project.readSaved(secondPath)).toBe("# Second doc\n");

    // "Closing the project and reopening it" — a full reload discards every in-memory React
    // state, so restoring the tab set here can only come from the persisted `store::tab_session`
    // snapshot on disk, never leftover app state.
    await page.reload();
    await pauseAutosave(page); // the reload rebuilt the page global — re-pause after hydration.
    // Startup hydration reattaches React to the backend-owned project without reopening it. The
    // persisted tab snapshot is therefore the only source for the restored set below.

    // Both tabs restored, not just the one path this reopen call named.
    await expect(page.getByRole("tab", { name: project.path, exact: false })).toBeVisible();
    const restoredSecondTab = page.getByRole("tab", { name: secondPath, exact: false });
    await expect(restoredSecondTab).toBeVisible();
    // Still dirty after restore — the 6px status dot hi-fi 3a/3b puts inside the tab (#1116).
    await expect(restoredSecondTab.locator(".tab-bar__dot")).toBeVisible();
    await restoredSecondTab.click();
    await expect(page.locator(".cm-content:visible")).toContainText(unsavedAddition);

    // Dirty-close guard, Cancel path: aborts the close, tab + content survive untouched.
    await page.getByRole("button", { name: `Close ${secondPath}` }).click();
    const guard = page.getByRole("alertdialog");
    await expect(guard).toBeVisible();
    await guard.getByRole("button", { name: "Cancel" }).click();
    await expect(guard).toBeHidden();
    await expect(restoredSecondTab).toBeVisible();
    await expect(page.locator(".cm-content:visible")).toContainText(unsavedAddition);

    // Dirty-close guard, Save path: writes the real content to disk, then closes the tab.
    await page.getByRole("button", { name: `Close ${secondPath}` }).click();
    await expect(guard).toBeVisible();
    await guard.getByRole("button", { name: "Save" }).click();
    await expect(guard).toBeHidden();
    await expect(restoredSecondTab).toBeHidden();
    await expect.poll(() => project.readSaved(secondPath)).toContain(unsavedAddition);
  });

  // #1116's own edge. The defect was pure CSS — `TabBar` had no `.tab-bar` rules at all, so every
  // open document laid out as a full-width stacked row — and jsdom, which the vitest half runs in,
  // performs no layout and leaves `var(--…)` unresolved. Only a real browser can prove the strip
  // *is* one horizontal row of content-sized tabs in the shipped theme, so the geometry and the
  // resolved 3a/3b colors are asserted here.
  const windowsTabStrip = {
    name: "Windows",
    navigatorPlatform: "Win32",
    stripBackground: "rgb(240, 237, 230)",
    activeBackground: "rgb(252, 251, 248)",
    stripPaddingBottom: "0px",
    columnGap: "2px",
    activeTopRadius: "6px",
    activeBottomRadius: "0px",
    activeJoinsCanvas: true,
  };
  const macTabStrip = {
    name: "macOS",
    navigatorPlatform: "MacIntel",
    stripBackground: "rgb(247, 245, 239)",
    activeBackground: "rgb(255, 255, 255)",
    stripPaddingBottom: "8px",
    columnGap: "6px",
    activeTopRadius: "7px",
    activeBottomRadius: "7px",
    activeJoinsCanvas: false,
  };

  test("the tab strip is one horizontal row of Windows folder tabs, not stacked filename rows", async ({
    page,
  }) => {
    await assertTabStrip(page, windowsTabStrip);
  });

  test("the tab strip is one horizontal row of macOS pill tabs, not stacked filename rows", async ({
    page,
  }) => {
    await assertTabStrip(page, macTabStrip);
  });

  async function assertTabStrip(page, platform) {
    const longName = "a-document-title-long-enough-to-dictate-the-whole-row-width.md";
    const longPath = project.addFile(longName, "# Long name\n");
    await reportPlatform(page, platform.navigatorPlatform);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    await openTab(page, project.path);
    await openTab(page, secondPath);
    await openTab(page, longPath);
    await expect(page.getByRole("tab")).toHaveCount(3);

    const strip = page.getByRole("tablist");
    await chooseTheme(page, "Light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const light = await tabStripAppearance(strip);

    // One horizontal row: the three tabs share a top edge and each starts to the right of the last.
    // The reported defect is exactly the opposite — three tops, one repeated left.
    expect(light.tabs.map((tab) => tab.top)).toEqual([
      light.tabs[0].top,
      light.tabs[0].top,
      light.tabs[0].top,
    ]);
    const lefts = light.tabs.map((tab) => tab.left);
    expect(lefts).toEqual([...lefts].sort((a, b) => a - b));
    expect(new Set(lefts).size).toBe(3);
    // No tab spans the strip: each is sized to its own label, never a full-width row.
    for (const tab of light.tabs) expect(tab.width).toBeLessThan(light.stripWidth / 2);

    expect(light).toMatchObject({
      display: "flex",
      flexWrap: "nowrap",
      // Not a scroll container, deliberately: see the join asserted below.
      overflowX: "visible",
      overflowY: "visible",
      stripBackground: platform.stripBackground,
      stripPaddingTop: "8px",
      stripPaddingLeft: "12px",
      stripPaddingBottom: platform.stripPaddingBottom,
      columnGap: platform.columnGap,
      activeBackground: platform.activeBackground,
      activeTopRadius: platform.activeTopRadius,
      activeBottomRadius: platform.activeBottomRadius,
      // The active tab is distinguished by fill and weight, not by position (`#1116`).
      inactiveBackground: "rgba(0, 0, 0, 0)",
      activeWeight: "500",
      inactiveWeight: "400",
    });

    // The Windows folder tab is "joined to the content area" (#1116) — `margin-bottom:-1px` in
    // `specs/platform-variants.md` "Document tabs" — so the active fill, not the strip's hairline,
    // is what paints under it all the way to the strip's bottom edge. Sampled from the rendered
    // pixels because that join is destroyed by clipping alone: a scroll container (which
    // `overflow-x: auto` makes the strip, dragging `overflow-y` to `auto` with it) cuts its
    // descendants off at the padding box, which is exactly the 1px in question, while every
    // declared and laid-out value stays as it is. The macOS pill floats 8px clear of the same
    // edge, so there the strip's own hairline is the last row — the platform difference, pinned.
    const hairline = "rgb(227, 223, 214)"; // --color-tab-border, hi-fi #E3DFD6.
    const activeColumn = await activeTabColumn(page, strip);
    expect(activeColumn.at(-1)).toBe(
      platform.activeJoinsCanvas ? platform.activeBackground : hairline,
    );
    if (platform.activeJoinsCanvas) expect(activeColumn).not.toContain(hairline);

    // The over-long filename is truncated in layout rather than dictating the row width: its tab
    // stops at the bound, the label renders narrower than its own text, and the full text is still
    // there for the tooltip and the accessible name. That the truncation *reads* as an ellipsis is
    // the `text-overflow` declaration, which the vitest half of this row asserts.
    const longTab = light.tabs.find((tab) => tab.title === longPath);
    expect(longTab.width).toBeLessThanOrEqual(220);
    expect(longTab.labelText).toBe(longName);
    expect(longTab.labelScrollWidth).toBeGreaterThan(longTab.labelClientWidth);

    // FR-X-6: the same strip in dark, derived from the app palette rather than the light literals.
    await chooseTheme(page, "Dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const dark = await tabStripAppearance(strip);
    expect(dark).toMatchObject({
      stripBackground: "rgb(38, 40, 44)",
      activeBackground: "rgb(30, 31, 34)",
      inactiveBackground: "rgba(0, 0, 0, 0)",
    });
    expect(dark.tabs.map((tab) => tab.top)).toEqual([
      dark.tabs[0].top,
      dark.tabs[0].top,
      dark.tabs[0].top,
    ]);
  }

  /**
   * The colors actually painted down the last few rows of the active tab, from inside the tab to
   * the strip's bottom edge inclusive — the one question `getComputedStyle` cannot answer, because
   * clipping (a scroll container removes everything past the padding box) changes what reaches the
   * screen without changing a single declared or laid-out value. Screenshotting a 1px-wide column
   * and decoding it through the page's own canvas keeps this dependency-free; hit-testing was
   * tried first and is unusable here, since Chromium snaps a fractional row to whole pixels.
   */
  async function activeTabColumn(page, strip) {
    const clip = await strip.evaluate((element) => {
      const active = element.querySelector('[aria-selected="true"]');
      if (!active) throw new Error("Tab strip has no active tab");
      const stripBox = element.getBoundingClientRect();
      const activeBox = active.getBoundingClientRect();
      const top = Math.round(activeBox.bottom) - 3;
      return {
        x: Math.round(activeBox.left + activeBox.width / 2),
        y: top,
        width: 1,
        height: Math.round(stripBox.bottom) - top,
      };
    });
    const shot = await page.screenshot({ clip });
    return page.evaluate(async (dataUrl) => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      const pixels = [];
      for (let i = 0; i < data.length; i += 4) {
        pixels.push(`rgb(${data[i]}, ${data[i + 1]}, ${data[i + 2]})`);
      }
      return pixels;
    }, `data:image/png;base64,${shot.toString("base64")}`);
  }

  async function tabStripAppearance(strip) {
    return strip.evaluate((element) => {
      const tabs = Array.from(element.querySelectorAll('[role="tab"]'));
      const active = element.querySelector('[aria-selected="true"]');
      const inactive = element.querySelector('[aria-selected="false"]');
      if (tabs.length === 0 || !active || !inactive) {
        throw new Error("Tab strip appearance targets are missing");
      }
      const stripStyle = getComputedStyle(element);
      const activeStyle = getComputedStyle(active);
      return {
        display: stripStyle.display,
        flexWrap: stripStyle.flexWrap,
        overflowX: stripStyle.overflowX,
        overflowY: stripStyle.overflowY,
        columnGap: stripStyle.columnGap,
        stripBackground: stripStyle.backgroundColor,
        stripPaddingTop: stripStyle.paddingTop,
        stripPaddingBottom: stripStyle.paddingBottom,
        stripPaddingLeft: stripStyle.paddingLeft,
        stripWidth: element.getBoundingClientRect().width,
        activeBackground: activeStyle.backgroundColor,
        activeTopRadius: activeStyle.borderTopLeftRadius,
        activeBottomRadius: activeStyle.borderBottomLeftRadius,
        activeWeight: activeStyle.fontWeight,
        inactiveBackground: getComputedStyle(inactive).backgroundColor,
        inactiveWeight: getComputedStyle(inactive).fontWeight,
        tabs: tabs.map((tab) => {
          const label = tab.querySelector(".tab-bar__label");
          const box = tab.getBoundingClientRect();
          return {
            title: tab.getAttribute("title"),
            top: Math.round(box.top),
            left: Math.round(box.left),
            width: box.width,
            labelText: label?.textContent ?? "",
            labelScrollWidth: label?.scrollWidth ?? 0,
            labelClientWidth: label?.clientWidth ?? 0,
          };
        }),
      };
    });
  }
});

test.describe("P2a-5 redline decorations + accept/reject triage", () => {
  /** @type {ReturnType<typeof createFixtureProject>} */
  let project;

  test.afterEach(async ({ page }) => {
    await project.cleanup(page);
  });

  async function openDoc(page, root, path) {
    await page.evaluate(
      ({ root: r, path: p }) => window.__EMEND_E2E__?.openProject(r, p),
      { root, path },
    );
  }

  test("renders CriticMarkup as redline and clicking a redline opens the accept/reject popover", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 720 });
    // The document ships with a pending agent insertion (CriticMarkup on disk — the source of truth).
    project = createFixtureProject("Hello {++brave ++}world\n");
    await page.goto("/");
    // Pause autosave so the post-decision disk assertion isn't raced by the 1 s debounce.
    await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(3_600_000));
    await openDoc(page, project.root, project.path);

    // Redline: the inserted text is decorated (green underline), its `{++`/`++}` braces hidden.
    const insertion = page.locator(".cm-redlineInsert");
    await expect(insertion).toHaveText("brave ");
    await expect(page.getByRole("group", { name: "Review changes" })).toContainText("1 of 1");
    const status = page.getByRole("region", { name: "Document status" });
    await expect(status).toContainText("1 tracked change");

    // Clicking the redline directly opens the popover — "no mode required" (J1).
    await insertion.click();
    const popover = page.getByRole("dialog");
    await expect(popover).toBeVisible();
    // The added side of the diff (aria-label "Added text") — located by its class, as Playwright's
    // getByLabel targets form controls, not an aria-labelled span.
    await expect(popover.locator(".redline-popover__new")).toHaveText("brave ");

    // Accept from the popover commits the decision to the document, then to disk.
    await popover.getByRole("button", { name: "✓ Accept" }).click();
    await expect(page.locator(".cm-content")).toContainText("Hello brave world");
    await expect(page.getByRole("group", { name: "Review changes" })).toHaveCount(0);
    await expect(status).not.toContainText("tracked change");
    await page.keyboard.press(`${mod}+s`);
    await expect.poll(() => project.readSaved()).toBe("Hello brave world\n");
  });

  test("keyboard-only triage: platform Mod+Enter accepts and Mod+Backspace rejects (FR-X-1)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 720 });
    // Two pending changes, each at a line start so the caret lands on them by keyboard alone.
    project = createFixtureProject("{++Accept me ++}stays\n{--Reject me --}also stays\n");
    await page.goto("/");
    await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(3_600_000));
    await openDoc(page, project.root, project.path);
    await expect(page.getByRole("group", { name: "Review changes" })).toContainText("1 of 2");

    const editor = page.locator(".cm-content");
    await editor.click();
    await expect(editor).toBeFocused();

    // Caret to the top-of-document insertion, accept it with the platform accept chord.
    await page.keyboard.press(`${mod}+Home`);
    await page.keyboard.press(`${mod}+Enter`);
    await expect(editor.locator(".cm-line").first()).toHaveText("Accept me stays");
    await expect(page.getByRole("group", { name: "Review changes" })).toContainText("1 of 1");
    await expect(editor).toBeFocused();

    // Caret to the second line's deletion (down a line, then to its start), reject it — its struck
    // text stays. ArrowDown + Home is platform-neutral (unlike Mod+Arrow, which differs on macOS).
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    await page.keyboard.press(`${mod}+Backspace`);
    await expect(page.getByRole("group", { name: "Review changes" })).toHaveCount(0);
    await expect(editor.locator(".cm-line").nth(1)).toHaveText("Reject me also stays");
    await expect(editor).toBeFocused();

    const expectedSaved = "Accept me stays\nReject me also stays\n";
    const saveIssued = page.waitForRequest("**/save_document");
    const saveCompleted = page.waitForResponse("**/save_document");
    await page.keyboard.press(`${mod}+s`);
    const saveRequest = await saveIssued;
    expect(saveRequest.postDataJSON()).toMatchObject({
      root: project.root,
      path: project.path,
      content: expectedSaved,
    });
    const saveResponse = await saveCompleted;
    expect(saveResponse.request()).toBe(saveRequest);
    expect(saveResponse.ok()).toBe(true);
    expect(project.readSaved()).toBe(expectedSaved);
  });
});

test.describe("P2a-22 J8 zero-provider editor-only mode", () => {
  /** @type {ReturnType<typeof createFixtureProject>} */
  let project;

  test.beforeEach(() => {
    project = createFixtureProject("# Zero-provider project\n");
  });

  test.afterEach(async ({ page }) => {
    await project.cleanup(page);
  });

  test("welcome screen shows both providers as not installed — an opened project then shows exactly one quiet editor-only chip and no nag", async ({
    page,
  }) => {
    await page.goto("/");

    // The test-driver's PATH lookup is redirected to guaranteed-absent binary names
    // (playwright.config.mjs) so this is real detection logic, deterministically zero-provider —
    // not a mock (CLAUDE.md: never mock in e2e).
    await expect(page.getByText("Claude Code — not installed")).toBeVisible();
    await expect(page.getByText("Copilot CLI — not installed")).toBeVisible();
    await expect(page.getByText(/editor works fully/)).toBeVisible();
    // Not-installed never offers the sign-in remediation meant for an installed-but-signed-out CLI.
    await expect(page.getByRole("button", { name: "Guide me through sign-in" })).toHaveCount(0);

    // No folder-picker UI can be driven headlessly (native OS dialog) — the dev-only e2e test hook
    // (D23) opens the project/doc directly, same as every other journey in this file.
    await page.evaluate(
      ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
      { root: project.root, path: project.path },
    );

    await expect(page.locator(".cm-content")).toBeVisible();
    const chip = page.getByRole("status");
    await expect(chip).toBeVisible();
    await expect(chip).toContainText("Editor-only");
    // Exactly one — no modal, no blocking nag (FR-X-7).
    await expect(page.getByRole("status")).toHaveCount(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Document status" })).toContainText(
      "Claude Code · not installed",
    );
  });
});

test.describe("P2a-8 editor-view control + display-mode UI", () => {
  /** @type {ReturnType<typeof createFixtureProject>} */
  let project;

  test.afterEach(async ({ page }) => {
    await project.cleanup(page);
  });

  async function openDoc(page, root, path) {
    await page.evaluate(
      ({ root: r, path: p }) => window.__EMEND_E2E__?.openProject(r, p),
      { root, path },
    );
  }

  test("D27 mixed-case .Txt keeps source bytes while Rich text projects Markdown", async ({ page }) => {
    const path = "field-notes.Txt";
    const raw = "# Field notes\r\n\r\nAn **important** café\r\n";
    project = createFixtureProject("# Seed\n");
    project.addFile(path, raw);
    // Windows presents the completed save in Document status on every host.
    await reportPlatform(page, "Win32");
    await page.goto("/");
    await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(3_600_000));
    await openDoc(page, project.root, path);

    const toolbar = page.getByRole("toolbar", { name: "Editor view controls" });
    const editor = page.locator(".cm-content:visible");
    await expect(page.getByRole("tab", { name: /field-notes\.Txt/ })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Rich text" })).toBeVisible();
    await expect(page.locator(".cm-heading1", { hasText: "Field notes" })).toHaveText("Field notes");
    await expect(page.locator(".cm-strong")).toContainText("important");
    await expect(page.locator(".cm-strong")).toHaveCSS("font-weight", "700");
    await expect(page.locator(".cm-markupHidden").first()).toHaveCSS("opacity", "0");

    await toolbar.getByRole("button", { name: "Markdown" }).click();
    await expect(page.locator(".cm-markupHidden")).toHaveCount(0);
    await expect(editor).toContainText("# Field notes");
    await expect(editor).toContainText("**important**");
    await page.getByRole("button", { name: "Don't convert this file" }).click();
    await editor.click();
    const saveCompleted = page.waitForResponse("**/save_document");
    await page.keyboard.press("Control+s");
    const saveResponse = await saveCompleted;
    expect(saveResponse.ok()).toBe(true);
    expect(saveResponse.request().postDataJSON()).toMatchObject({
      root: project.root,
      path,
      content: raw,
      normalizeLineEndings: false,
    });
    const savedStatus = page.getByRole("region", { name: "Document status" }).getByText(/^Saved · /);
    await expect(savedStatus).toBeVisible();
    expect(readFileSync(join(project.root, path))).toEqual(Buffer.from(raw, "utf8"));

    await toolbar.getByRole("button", { name: "Rich text" }).click();
    await expect(page.locator(".cm-strong")).toContainText("important");
    await editor.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("## Rewritten\n\nAn **important** café\n");
    await page.keyboard.press("Control+s");
    const expected = "## Rewritten\r\n\r\nAn **important** café\r\n";
    await expect.poll(() => readFileSync(join(project.root, path)).equals(Buffer.from(expected, "utf8")))
      .toBe(true);
  });

  test("B4b moves only non-fitting existing toolbar controls beside the pinned mic", async ({ page }) => {
    project = createFixtureProject("{++pending++}\n");
    await reportPlatform(page, "Win32");
    await page.goto("/");
    await openDoc(page, project.root, project.path);
    const toolbar = page.getByRole("toolbar", { name: "Editor view controls" });
    await expect(toolbar.getByRole("group", { name: "Review changes" })).toContainText("1 of 1");
    await toolbar.evaluate((element) => { element.style.width = "660px"; });

    const more = toolbar.getByRole("button", { name: "More editor controls" });
    await expect(more).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "✓ Accept" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "✗ Reject" })).toBeVisible();
    await expect(toolbar.getByRole("button", { name: "Next change" })).toBeVisible();
    await expect(toolbar.getByText("Bulk ▾")).toBeHidden();
    await expect(toolbar.getByRole("button", { name: "Dictate — unavailable in this build" })).toBeVisible();
    expect(await more.evaluate((button) => ({
      width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height,
    }))).toEqual({ width: 28, height: 26 });
    await expect.poll(() => toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);

    await toolbar.evaluate((element) => { element.style.width = "700px"; });
    await expect(more).toHaveCount(0);
    await expect(toolbar.getByText("Bulk ▾")).toBeVisible();
    await toolbar.evaluate((element) => { element.style.width = "660px"; });
    await expect(more).toBeVisible();

    await more.click();
    await expect(toolbar.getByText("Bulk ▾")).toBeVisible();
    await toolbar.getByText("Bulk ▾").click();
    await toolbar.getByRole("button", { name: "Accept all insertions" }).click();
    await expect(toolbar.getByRole("group", { name: "Review changes" })).toHaveCount(0);
    await expect(page.locator(".cm-content")).toContainText("pending");
  });

  test("B4b keeps narrow existing actions reachable by keyboard as context changes", async ({ page }) => {
    project = createFixtureProject("{++pending++}\n");
    await reportPlatform(page, "Win32");
    await page.goto("/");
    await openDoc(page, project.root, project.path);
    const toolbar = page.getByRole("toolbar", { name: "Editor view controls" });
    await expect(toolbar.getByRole("group", { name: "Review changes" })).toContainText("1 of 1");
    await toolbar.evaluate((element) => { element.style.width = "330px"; });
    const more = toolbar.getByRole("button", { name: "More editor controls" });
    await expect(more).toBeVisible();
    await expect.poll(() => toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);

    await toolbar.evaluate((element) => { element.style.width = "700px"; });
    await expect(more).toHaveCount(0);
    await toolbar.getByText("Bulk ▾").focus();
    await toolbar.evaluate((element) => { element.style.width = "330px"; });
    await expect(more).toBeVisible();
    await expect(more).toBeFocused();

    await page.keyboard.press("ArrowDown");
    const popover = toolbar.getByRole("dialog", { name: "More editor controls" });
    await expect(popover).toBeVisible();
    await expect(popover.getByRole("button", { name: "✓ Accept" })).toBeVisible();
    await expect(popover.getByText("Bulk ▾")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();
    await expect(more).toBeFocused();

    await more.click();
    await popover.getByRole("button", { name: "✓ Accept" }).click();
    await expect(toolbar.getByRole("group", { name: "Review changes" })).toHaveCount(0);
    await expect(page.locator(".cm-content")).toContainText("pending");
    await expect.poll(() => toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
  });

  test("B4b restores keyboard focus when overflow changes", async ({ page }) => {
    project = createFixtureProject("{++pending++}\n");
    await reportPlatform(page, "Win32");
    await page.goto("/");
    await openDoc(page, project.root, project.path);
    const toolbar = page.getByRole("toolbar", { name: "Editor view controls" });
    await expect(toolbar.getByRole("group", { name: "Review changes" })).toContainText("1 of 1");
    await toolbar.evaluate((element) => { element.style.width = "330px"; });

    const more = toolbar.getByRole("button", { name: "More editor controls" });
    await expect(more).toBeVisible();
    await more.focus();
    await page.keyboard.press("ArrowDown");
    const popover = toolbar.getByRole("dialog", { name: "More editor controls" });
    const movedBulk = popover.getByText("Bulk ▾");
    await expect(movedBulk).toBeVisible();
    await movedBulk.focus();
    await expect(movedBulk).toBeFocused();

    for (let cycle = 0; cycle < 20; cycle += 1) {
      await toolbar.evaluate((element) => { element.style.width = "500px"; });
      await expect(popover.getByRole("button", { name: "Next change" })).toBeVisible();
      await expect(movedBulk).toBeFocused();

      await toolbar.evaluate((element) => { element.style.width = "700px"; });
      await expect(more).toHaveCount(0);
      await expect(toolbar.getByText("Bulk ▾")).toBeFocused();
      if (cycle < 19) {
        await toolbar.evaluate((element) => { element.style.width = "330px"; });
        await expect(more).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await movedBulk.focus();
        await expect(movedBulk).toBeFocused();
      }
    }

    await toolbar.evaluate((element) => { element.style.width = "330px"; });
    await expect(more).toBeFocused();
    await toolbar.evaluate((element) => { element.style.width = "700px"; });
    await expect(more).toHaveCount(0);
    await expect(toolbar.getByRole("group", { name: "Editor view" }).getByRole("button", { name: "Rich text" }))
      .toBeFocused();
  });

  test("B4b macOS overflow chip keeps the moved action accessible", async ({ page }) => {
    project = createFixtureProject("{++pending++}\n");
    await reportPlatform(page, "MacIntel");
    await page.goto("/");
    await openDoc(page, project.root, project.path);
    const toolbar = page.getByRole("toolbar", { name: "Editor view controls" });
    await toolbar.evaluate((element) => { element.style.width = "700px"; });
    await expect(toolbar.getByRole("group", { name: "Review changes" })).toContainText("1 of 1");
    await toolbar.evaluate((element) => { element.style.width = "660px"; });
    const more = toolbar.getByRole("button", { name: "More editor controls" });
    await expect(more).toBeVisible();
    expect(await more.evaluate((button) => ({
      width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height,
      radius: getComputedStyle(button).borderRadius,
    }))).toEqual({ width: 28, height: 26, radius: "7px" });
    await more.click();
    const popover = toolbar.getByRole("dialog", { name: "More editor controls" });
    await expect(popover.getByText("Bulk ▾")).toBeVisible();
    await expect.poll(() => toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth))
      .toBe(true);
  });

  test("B4b moves the four existing format controls as one group after review controls", async ({ page }) => {
    project = createFixtureProject("{++pending++}\n\nword");
    await reportPlatform(page, "Win32");
    await page.goto("/");
    await openDoc(page, project.root, project.path);
    const toolbar = page.getByRole("toolbar", { name: "Editor view controls" });
    await expect(toolbar.getByRole("group", { name: "Review changes" })).toContainText("1 of 1");

    await toolbar.getByRole("button", { name: "Markdown" }).click();

    for (const width of [600, 560, 520, 480, 440, 400, 360, 330]) {
      await toolbar.evaluate((element, value) => { element.style.width = `${value}px`; }, width);
      await expect.poll(() => toolbar.evaluate((element) => element.scrollWidth <= element.clientWidth))
        .toBe(true);
      const inlineFormatCount = await toolbar.locator(
        ".view-mode-toolbar__format button:visible",
      ).count();
      expect([0, 4], `format group at ${width}px`).toContain(inlineFormatCount);
    }

    const editor = page.locator(".cm-content");
    await editor.locator(".cm-line").last().click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");

    const more = toolbar.getByRole("button", { name: "More editor controls" });
    await more.focus();
    await page.keyboard.press("ArrowDown");
    const popover = toolbar.getByRole("dialog", { name: "More editor controls" });
    await expect(popover.getByRole("button", { name: "Bold" })).toBeVisible();
    expect(await popover.locator('[data-toolbar-control^="format-"] button').evaluateAll(
      (buttons) => buttons.map((button) => button.getAttribute("aria-label")),
    )).toEqual(["Bold", "Italic", "Heading 1", "Bulleted list"]);
    await popover.getByRole("button", { name: "Bold" }).focus();
    await page.keyboard.press("Enter");
    await expect(editor).toContainText("**word**");
    await expect(popover).toBeHidden();
    await expect(more).toBeFocused();

    await editor.locator(".cm-line").last().click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await more.click();
    await popover.getByRole("button", { name: "Italic" }).click();
    await expect(editor).toContainText("***word***");
  });

  test("Markdown control preserves cursor position across the switch", async ({ page }) => {
    project = createFixtureProject("abcdef\n");
    await page.goto("/");
    await openDoc(page, project.root, project.path);

    const editor = page.locator(".cm-content");
    await editor.click();
    await page.keyboard.press(`${mod}+Home`);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight"); // caret now sits between "b" and "c"

    await page.getByRole("button", { name: "Markdown" }).click();
    // Refocus the editor (a DOM `.focus()`, not a click — a click would itself move the caret to
    // wherever it landed, defeating the very thing this test checks) before typing.
    await editor.focus();
    await page.keyboard.type("Z"); // lands exactly where the caret was, unmoved by the toggle

    await expect(editor).toContainText("abZcdef");
  });

  test("shared format controls and Mod-B/Mod-I edit the same source target in Markdown on one bound row (#2414)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 720 });
    const raw = "{++pending++}\n\nword\n";
    project = createFixtureProject(raw);
    await page.goto("/");
    await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(3_600_000));
    await openDoc(page, project.root, project.path);
    await page.getByRole("button", { name: "Markdown" }).click();

    const editor = page.locator(".cm-content");
    const toolbar = page.getByRole("toolbar", { name: "Editor view controls" });
    const formatting = toolbar.getByRole("group", { name: "Formatting" });
    const review = toolbar.getByRole("group", { name: "Review changes" });
    await expect(page.locator(".editor-shell").getByRole("toolbar")).toHaveCount(1);
    await expect(review).toContainText("1 of 1");
    await expect(formatting.getByRole("button")).toHaveText(["B", "I", "H1", "≔"]);
    for (const name of ["Bold", "Italic", "Heading 1", "Bulleted list"]) {
      await expect(formatting.getByRole("button", { name })).not.toHaveAttribute("aria-busy");
    }
    const displayedMod = process.platform === "darwin" ? "⌘" : "Ctrl+";
    await expect(formatting.getByRole("button", { name: "Bold" })).toHaveAttribute(
      "title",
      `Bold (${displayedMod}B)`,
    );
    await expect(formatting.getByRole("button", { name: "Italic" })).toHaveAttribute(
      "title",
      `Italic (${displayedMod}I)`,
    );
    await expect(formatting.getByRole("button", { name: "Heading 1" })).toHaveAttribute("title", "Heading 1");
    await expect(formatting.getByRole("button", { name: "Bulleted list" })).toHaveAttribute("title", "Bulleted list");

    const boundInactiveStyle = await toolbar.evaluate((element) => {
      const button = element.querySelector('[aria-label="Bold"]');
      if (!(button instanceof HTMLButtonElement)) throw new Error("Bold control missing");
      const pressed = button.getAttribute("aria-pressed");
      button.removeAttribute("aria-pressed");
      button.setAttribute("aria-disabled", "true");
      button.setAttribute("aria-busy", "true");
      const style = getComputedStyle(button);
      const result = {
        toolbarBorder: getComputedStyle(element).borderBottomColor,
        color: style.color,
        opacity: style.opacity,
        background: style.backgroundColor,
      };
      button.removeAttribute("aria-disabled");
      button.removeAttribute("aria-busy");
      if (pressed !== null) button.setAttribute("aria-pressed", pressed);
      return result;
    });
    expect(boundInactiveStyle).toEqual({
      toolbarBorder: "rgb(227, 223, 214)",
      color: "rgb(163, 158, 146)",
      opacity: "1",
      background: "rgb(255, 255, 255)",
    });

    await editor.click();
    await page.keyboard.press(`${mod}+End`);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await formatting.getByRole("button", { name: "Bold" }).click();
    await expect(editor).toContainText("**word**");
    await expect(editor).toBeFocused();
    const pressedStyle = await formatting.getByRole("button", { name: "Bold" }).evaluate((button) => {
      const style = getComputedStyle(button);
      return {
        background: style.backgroundColor,
        color: style.color,
        width: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height,
      };
    });
    expect(pressedStyle).toEqual({
      background: "rgb(79, 70, 229)",
      color: "rgb(255, 255, 255)",
      width: 27,
      height: 26,
    });
    const boldButton = formatting.getByRole("button", { name: "Bold" });
    await toolbar.getByRole("button", { name: "Markdown" }).focus();
    await page.keyboard.press("Tab");
    await expect(boldButton).toBeFocused();
    const focusStyle = await boldButton.evaluate((button) => {
      const style = getComputedStyle(button);
      return {
        platform: button.closest(".view-mode-toolbar")?.getAttribute("data-platform"),
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineOffset: style.outlineOffset,
        boxShadow: style.boxShadow,
      };
    });
    if (focusStyle.platform === "mac") {
      expect(focusStyle.outlineStyle).toBe("none");
      expect(focusStyle.boxShadow).toContain("rgba(79, 70, 229, 0.72) 0px 0px 0px 3px");
    } else {
      expect(focusStyle).toMatchObject({
        outlineColor: "rgb(79, 70, 229)",
        outlineWidth: "2px",
        outlineOffset: "1px",
      });
    }
    await formatting.getByRole("button", { name: "Bold" }).click();
    await expect(editor).not.toContainText("**word**");

    await formatting.getByRole("button", { name: "Italic" }).click();
    await expect(editor).toContainText("*word*");
    await formatting.getByRole("button", { name: "Italic" }).click();
    await expect(editor).not.toContainText("*word*");

    await formatting.getByRole("button", { name: "Heading 1" }).click();
    await expect(editor).toContainText("# word");
    await formatting.getByRole("button", { name: "Heading 1" }).click();
    await expect(editor).not.toContainText("# word");

    await formatting.getByRole("button", { name: "Bulleted list" }).click();
    await expect(editor).toContainText("- word");
    await formatting.getByRole("button", { name: "Bulleted list" }).click();
    await expect(editor).not.toContainText("- word");

    await page.keyboard.press(`${mod}+b`);
    await expect(editor).toContainText("**word**");
    await page.keyboard.press(`${mod}+b`);
    await expect(editor).not.toContainText("**word**");
    await page.keyboard.press(`${mod}+i`);
    await expect(editor).toContainText("*word*");

    const geometry = await toolbar.evaluate((element) => {
      element.style.width = "700px";
      const children = [...element.children]
        .filter((child) => !child.classList.contains("view-mode-toolbar__overflow-popover"))
        .map((child) => child.getBoundingClientRect());
      const firstCenter = children[0].top + children[0].height / 2;
      const style = getComputedStyle(element);
      return {
        flexWrap: style.flexWrap,
        overflow: style.overflow,
        fits: element.scrollWidth <= element.clientWidth,
        oneRow: children.every(
          (rect) => Math.abs(rect.top + rect.height / 2 - firstCenter) < 0.5,
        ),
        formatHeights: [...element.querySelectorAll(".view-mode-toolbar__format-option")].map(
          (button) => button.getBoundingClientRect().height,
        ),
      };
    });
    expect(geometry).toEqual({
      flexWrap: "nowrap",
      overflow: "hidden",
      fits: true,
      oneRow: true,
      formatHeights: [26, 26, 26, 26],
    });

    await page.keyboard.press(`${mod}+s`);
    await expect.poll(() => project.readSaved()).toBe(
      "{++pending++}\n\n*word*\n",
    );
    await toolbar.getByRole("button", { name: "Rich text" }).click();
    await page.locator(".cm-redlineParagraph").click({ position: { x: 35, y: 10 } });
    const popover = page.getByRole("dialog", { name: "Insertion: review change" });
    await expect(popover).toBeVisible();
    expect(
      await popover.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return hit !== null && element.contains(hit);
      }),
    ).toBe(true);
    await review.getByRole("button", { name: "✓ Accept" }).click();
    await expect(review).toHaveCount(0);
    await expect(editor).toBeFocused();
  });

  test("hidden rich-text markup occupies one line while ordinary prose still wraps (#2391)", async ({
    page,
  }) => {
    const wrappedProse = Array.from(
      { length: 24 },
      (_, index) => `ordinary prose segment ${index + 1}`,
    ).join(" ");
    const raw = [
      "plain anchor",
      "# H1",
      "### H3",
      "> quoted line",
      "- list item",
      "has **bold** *italic*",
      wrappedProse,
      "",
    ].join("\n");
    project = createFixtureProject(raw);
    await page.setViewportSize({ width: 760, height: 700 });
    await page.goto("/");
    await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(3_600_000));
    await openDoc(page, project.root, project.path);

    // #2389 makes cursor reveal opt-in. This scenario exercises the revealed marker's geometry,
    // so enable that preference explicitly rather than depending on the former product default.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const reveal = page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("checkbox", { name: "Reveal markup at cursor" });
    await reveal.check();
    await expect(page.getByRole("dialog", { name: "Settings" }).getByRole("status", { name: "Settings save status" })).toHaveText(
      "Settings saved",
    );
    await page.getByRole("button", { name: "Close Settings" }).click();

    const editor = page.locator(".cm-content");
    for (const [label, text] of [
      ["H1", "H1"],
      ["H3", "H3"],
      ["blockquote", "quoted line"],
      ["list", "list item"],
      ["inline emphasis", "has "],
    ]) {
      const line = editor.locator(".cm-line").filter({ hasText: text }).first();
      await expect(line).toBeVisible();
      const lineHeightRatio = await line.evaluate((element) => {
        const ownLineHeight = Math.max(
          ...[element, ...element.querySelectorAll("*")].map((candidate) => {
            const style = getComputedStyle(candidate);
            return Math.max(
              Number.parseFloat(style.lineHeight),
              Number.parseFloat(style.fontSize),
            );
          }),
        );
        return element.getBoundingClientRect().height / ownLineHeight;
      });
      expect(lineHeightRatio, `${label} hidden markup line-height ratio`).toBeLessThanOrEqual(1.1);
    }

    const longLine = editor.locator(".cm-line").filter({ hasText: "ordinary prose segment 1" });
    const wrappedLineHeightRatio = await longLine.evaluate((element) => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      return element.getBoundingClientRect().height / lineHeight;
    });
    expect(wrappedLineHeightRatio).toBeGreaterThan(1.5);

    const h3Line = editor.locator(".cm-line").filter({ hasText: "H3" });
    await h3Line.click();
    await expect(h3Line.locator(".cm-markupRevealed")).toHaveText("### ");

    await page.keyboard.press(`${mod}+s`);
    await expect.poll(() => project.readSaved()).toBe(raw);

    // The D23 settings service is shared by this serial suite; restore the product default.
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Settings" })
      .getByRole("checkbox", { name: "Reveal markup at cursor" })
      .uncheck();
    await expect(page.getByRole("dialog", { name: "Settings" }).getByRole("status", { name: "Settings save status" })).toHaveText(
      "Settings saved",
    );
  });

  test("Markdown headings use plain body typography at every level (#2397)", async ({ page }) => {
    const raw = [
      "# Heading one",
      "## Heading two",
      "### Heading three",
      "#### Heading four",
      "##### Heading five",
      "###### Heading six",
      "Body reference",
      "",
    ].join("\n");
    project = createFixtureProject(raw);
    await page.goto("/");
    await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(3_600_000));
    await openDoc(page, project.root, project.path);

    const lines = page.locator(".cm-content .cm-line");
    const readMetrics = () =>
      lines.evaluateAll((elements) =>
        elements
          .filter((element) => element.textContent?.trim())
          .map((element) => {
            const textParents = new Set();
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              if (node.textContent?.trim() && node.parentElement) textParents.add(node.parentElement);
            }
            const distinctMetrics = new Map();
            for (const parent of textParents) {
              const style = getComputedStyle(parent);
              const metric = {
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                lineHeight: style.lineHeight,
              };
              distinctMetrics.set(JSON.stringify(metric), metric);
            }
            return [...distinctMetrics.values()];
          }),
      );

    const richMetrics = await readMetrics();
    const richHeadingSizes = richMetrics
      .slice(0, 6)
      .map((line) => Math.max(...line.map((metric) => Number.parseFloat(metric.fontSize))));
    expect(
      {
        sizesDescend: richHeadingSizes.every(
          (size, index) => index === 0 || richHeadingSizes[index - 1] > size,
        ),
        allBold: richMetrics
          .slice(0, 6)
          .every((line) => line.every((metric) => metric.fontWeight === "700")),
      },
      "Rich text preserves the H1-H6 visual hierarchy",
    ).toEqual({ sizesDescend: true, allBold: true });

    await page.getByRole("button", { name: "Markdown" }).click();
    const metrics = await readMetrics();
    const bodyMetrics = metrics.at(-1);
    expect(metrics.slice(0, 6), "Markdown H1-H6 glyphs match body typography").toEqual(
      Array.from({ length: 6 }, () => bodyMetrics),
    );

    await page.keyboard.press(`${mod}+s`);
    await expect.poll(() => project.readSaved()).toBe(raw);
  });

  test("Source view turns decorations off entirely; display modes resolve redline per FR-ED-4 without ever drifting the saved doc", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 720 });
    // CM6 collapses hidden markup via a zero-width CSS mark (never a DOM `replace`), so `.cm-content`'s
    // raw text content always contains every character regardless of decoration — assertions below
    // target the decoration classes themselves (as the P2a-5 redline suite already does), the same
    // way a real reader tells "hidden" from "shown".
    const raw = "Hello {++brave ++}world, {--cruel --}fate.\n";
    project = createFixtureProject(raw);
    await page.goto("/");
    // Pause autosave: every disk assertion below is a deliberate manual save, not a race with it.
    await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(3_600_000));
    await openDoc(page, project.root, project.path);

    const editor = page.locator(".cm-content");
    const editorViewToolbar = page.getByRole("toolbar", { name: "Editor view controls" });
    const documentStatus = page.getByRole("region", { name: "Document status" });
    const displayMode = documentStatus.getByRole("combobox", { name: "Display mode", exact: true });
    await expect(editorViewToolbar.getByRole("button", { name: "Rich text" })).toBeVisible();
    await expect(editorViewToolbar.getByRole("button", { name: "Markdown" })).toBeVisible();
    await expect(editorViewToolbar.getByLabel("Display mode")).toHaveCount(0);
    await expect(displayMode).toHaveValue("All");
    await expect(page.locator(".cm-redlineInsert")).toHaveText("brave ");

    // Source: decorations off entirely — no redline coloring, no hidden markers of any kind (the
    // delimiters that are normally `cm-markupHidden` off the caret's line are, here, plain text).
    await page.getByRole("button", { name: "Markdown" }).click();
    await expect(page.locator(".cm-redlineInsert")).toHaveCount(0);
    await expect(page.locator(".cm-redlineDelete")).toHaveCount(0);
    await expect(page.locator(".cm-markupHidden")).toHaveCount(0);
    await page.keyboard.press(`${mod}+s`);
    await expect.poll(() => project.readSaved()).toBe(raw); // the doc string never moved

    // Back to rich view: redline exactly as it started.
    await page.getByRole("button", { name: "Rich text" }).click();
    await expect(page.locator(".cm-redlineInsert")).toHaveText("brave ");

    // Display: None — the clean accept-all reading (FR-ED-4): the deleted side collapses to a
    // hidden marker (never rendered), the inserted side renders as ordinary plain text (no redline
    // decoration at all, since it's now "just" accepted content); editing is blocked.
    await displayMode.selectOption("None");
    await expect(page.locator(".cm-redlineInsert")).toHaveCount(0);
    await expect(page.locator(".cm-redlineDelete")).toHaveCount(0);
    await expect(page.locator(".cm-markupHidden", { hasText: "cruel " })).toHaveCount(1);
    await editor.click();
    await page.keyboard.type("nope");
    await expect(editor).not.toContainText("nope"); // read-only projection: typing has no effect
    await page.keyboard.press(`${mod}+s`);
    await expect.poll(() => project.readSaved()).toBe(raw);

    // Display: Original — the reject-all reading: the mirror image, also read-only.
    await displayMode.selectOption("Original");
    await expect(page.locator(".cm-redlineInsert")).toHaveCount(0);
    await expect(page.locator(".cm-redlineDelete")).toHaveCount(0);
    await expect(page.locator(".cm-markupHidden", { hasText: "brave " })).toHaveCount(1);
    await page.keyboard.press(`${mod}+s`);
    await expect.poll(() => project.readSaved()).toBe(raw);

    // Back to All: the still-pending redline, untouched by the whole round trip.
    await displayMode.selectOption("All");
    await expect(page.locator(".cm-redlineInsert")).toHaveText("brave ");
    await expect(page.getByRole("group", { name: "Review changes" })).toContainText("1 of 2");
    await page.keyboard.press(`${mod}+s`);
    await expect.poll(() => project.readSaved()).toBe(raw);
  });
});

test.describe("P2b-11c J4 — address a comment with AI (single, batch, defense, re-delegate)", () => {
  // Every thread here is seeded through `commentsDriver.mjs` — the same real, unmocked
  // `commands::comments` calls the app's own UI makes (P2b-11c wired `comments/ipc.ts` through the
  // D23 test driver for exactly this), standing in for "an existing open comment" (a reviewer's
  // note, or a review finding) the way `createFixtureProject`'s CriticMarkup already stands in for
  // "a change already delivered" elsewhere in this file. What "Address with AI" itself does is
  // always driven through the real UI below.
  //
  // The tracked-change + explanatory-reply half of a delivery (`linkChanges`/`replyToComment`) is
  // also played through `commentsDriver.mjs` rather than a live agent run. The UI calls the atomic
  // `start_address_run` command: it persists the Address event and admits the run under one comment
  // write lane. In this suite it reaches the real RunQueue and deterministically fails at the
  // driver's default-closed provider-spawn guard (#1149), never a real or billable CLI. No MCP
  // tool ties a delivered `propose_changes` back to a comment id either way (still P2a-15's job).
  // `linkChanges`/
  // `replyToComment` are exactly the two real backend calls a wired agent pipeline will eventually
  // make for this same delivery, so playing them directly is the fake-agent-shaped stand-in for
  // that missing wiring, not a mock of this journey's own UI-driven half (CLAUDE.md: never mock in
  // e2e — nothing here replaces application logic, only supplies the agent side no automatic
  // caller exists for yet).
  //
  // **The batch path's grouped-by-comment change-set card (#537):** `TimelinePanel.handleAddressAll`
  // now raises J4 Batch's own reviewable card (`timeline/batchChangeSetCard.ts`) from the real
  // `start_address_run` outcome, asserted below alongside the header accounting. Its groups
  // carry no changes yet — no MCP tool ties a delivered `propose_changes` back to a comment id
  // either (the same P2a-15 gap named above), so today's
  // honest shape is a card naming which comments the run addressed with a `0 changes · 0 replies ·
  // 0 defenses` count, ready to fill in once that pipeline exists.
  //
  // **Mid-batch interrupt (FR-AGENT-6, #538):** test-plan §4's other required highlight for this
  // journey is now reached end to end, through the deliberate fault window the D23 driver opens
  // (`commentsDriver.mjs#armBatchAddressFault`). It is not a mock and not a fake outcome: the batch
  // runs its production path, and the write that fails is the real `store::service` append against
  // a real read-only sidecar — the driver only makes that file unwritable inside the window
  // `commands::comments::start_address_run_on_watching` opens between two of the batch's own
  // appends. That seam exists because a *partial* batch is otherwise unreachable from outside the
  // backend: every target in one call appends to the same per-author file, opened and closed fresh
  // per thread, so failing it up front fails the *first* write ("none complete", not "some
  // complete, then fail"), and racing a real filesystem mutation into the gap would need a sleep
  // (test-plan §4/§7 forbid both mocking and timing-dependent tests). The other route — a real
  // agent run behind batch address, test-plan §4's own "fake agent … die mid-run" — is still
  // P2a-15's, and this coverage will move onto it when it lands.
  /** @type {ReturnType<typeof createFixtureProject>} */
  let project;

  test.afterEach(async ({ page }) => {
    await project.cleanup(page);
  });

  // `pauseAutosave` mirrors the P2a-6 suite's helper of the same name, and must happen *before* the
  // document opens: `EditorShell` reads the interval once, when it arms its scheduler at mount, so
  // setting it afterwards leaves the always-on 1 s autosave free to fire mid-scenario — the
  // wall-clock race test-plan §7 forbids.
  async function openDoc(page, { pauseAutosave = false } = {}) {
    await page.goto("/");
    if (pauseAutosave) {
      await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(3_600_000));
    }
    await page.evaluate(
      ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
      { root: project.root, path: project.path },
    );
    await expect(page.locator(".cm-content")).toBeVisible();
  }

  // A direct `commentsDriver` call lands entirely outside the mounted app's own React state (real
  // IPC, but made from this Node process, not the browser) — a reload makes the startup hydration
  // path reattach to that backend-owned project and re-fetch the fresh thread state.
  async function reopenAfterBackendChange(page) {
    await page.reload();
    await expect(page.locator(".cm-content")).toBeVisible();
  }

  function commentThreadDialog(page) {
    return page.getByRole("dialog", { name: "Comment thread" });
  }

  /** Clicks the anchored highlight for `word`'s thread (`commentHighlights.ts`'s deep-link click)
   * and returns the resulting view-mode popover — the "open this thread" step every test below
   * repeats at least once. */
  async function openCommentThread(page, word) {
    await page.locator(".cm-commentHighlight", { hasText: word }).click();
    return commentThreadDialog(page);
  }

  /**
   * A fully test-owned clock for comment-event timestamps (P2b-11c, test-plan §7's injectable-clock
   * discipline) — every `store::comments` event this journey produces, whether the browser's own UI
   * click stamps it or `commentsDriver.mjs`'s direct calls do, needs a value from *this* sequence,
   * never a bare `Date.now()` race between the browser's clock and this Node process's. The store's
   * causal fold orders every author's events by `(timestamp, id)` regardless of arrival order
   * (test-plan P5); racing two real clock reads for that ordering is exactly the kind of
   * intermittent failure test-plan §7 forbids (issue #367 review history: this file used to reach
   * for `Date.now() + <margin>`, which only relocates the same race rather than removing it).
   * `advance()` both pins the browser's own `now` (via the `setCommentNowMs` D23 hook, wired through
   * `TabbedEditor`/`TimelinePanel`'s `commentNow` prop to every comment surface) and returns the new
   * value, so a driver call immediately after can be given a timestamp provably later still.
   */
  // `start` lets a clock created *after* a reload (a fresh page, so a fresh client-side
  // `commentNowMs` starting again from nothing) resume from the last value the *previous* clock on
  // this same thread actually used — otherwise a new `commentClock` beginning back at a small
  // number would sort *before* an already-landed delivery in the causal fold, undoing the ordering
  // this whole mechanism exists to guarantee.
  function commentClock(page, start = 0) {
    let ms = start;
    return {
      async advance() {
        ms += 1000;
        await page.evaluate((value) => window.__EMEND_E2E__?.setCommentNowMs(value), ms);
        return ms;
      },
    };
  }

  /** The thread's TD-4 `address` events from the human author's sidecar log: the durable record
   * that [Address with AI] was made, however briefly its run then stays in flight. */
  function addressEvents(threadId) {
    const commentsDir = join(project.root, ".emend", "comments");
    if (!existsSync(commentsDir)) return [];
    const [docId] = readdirSync(commentsDir);
    const authorLog = join(commentsDir, docId, "you.jsonl");
    if (!existsSync(authorLog)) return [];
    // Every record ends in a newline; the final segment is empty or an append still in progress.
    return readFileSync(authorLog, "utf8").split("\n").slice(0, -1)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === "address" && event.parent_id === threadId);
  }

  /** Holds every `/run_state` response until `release()`. The real RunQueue still produces each
   * projection and the production poller still folds it; only the response cadence changes
   * (test-plan §7b). `held` resolves once the frontend has asked. `release()` lets every held
   * request through and waits for every held handler to forward its request; it removes every page
   * route, and the tests using it install no other. */
  async function holdRunStatePolls(page) {
    let releasePolls;
    let markHeld;
    const released = new Promise((resolve) => { releasePolls = resolve; });
    const held = new Promise((resolve) => { markHeld = resolve; });
    await page.route("**/run_state", async (route) => {
      markHeld();
      await released;
      await route.continue();
    });
    return {
      held,
      async release() {
        releasePolls();
        await page.unrouteAll({ behavior: "wait" });
      },
    };
  }

  /**
   * Clicks [Address with AI] on one thread and runs `assertInFlight` while its run is provably still
   * in flight. No agent CLI exists under e2e, so D23's provider fails every address run; the
   * frontend observes that one `/run_state` poll (50 ms) after `start_run` acknowledges, and the
   * terminal fold clears the Working-only line. An unheld DOM assertion races that (#58), so the
   * poll is held until the in-flight assertions have read the UI. Afterwards this waits for the
   * run's durable `failed` conclusion, so later steps start from one settled state.
   */
  async function addressWithAIWhileInFlight(page, popover, threadId, assertInFlight) {
    const polls = await holdRunStatePolls(page);
    try {
      await popover.getByRole("button", { name: "Address with AI" }).click();
      await expect.poll(() => addressEvents(threadId).length).toBe(1);
      await assertInFlight();
      // The poll was parked while the assertions read the UI; a hold that matches nothing fails here.
      await polls.held;
    } finally {
      await polls.release();
    }
    const [address] = addressEvents(threadId);
    await expect.poll(async () => (await loadCommentThreads(project.root, project.path))
      .find((thread) => thread.id === threadId).concluded_run)
      .toMatchObject({ run_id: address.run_id, outcome: "failed" });
    return address;
  }

  test("a CRLF document kept unnormalized draws and re-seeds its anchored comment on the exact word (#1799)", async ({
    page,
  }) => {
    const content = "hello world\r\nsecond line\r\n";
    project = createFixtureProject(content);
    await createComment(
      project.root,
      project.path,
      "reviewer",
      "Check this word.",
      {
        content,
        utf16Offset: content.indexOf("second"),
        utf16Length: "second".length,
      },
      0,
    );

    await openDoc(page, { pauseAutosave: true });
    await page.getByRole("button", { name: "Don't convert this file" }).click();

    let highlight = page.locator(".cm-commentHighlight", { hasText: "second" });
    await expect(highlight).toBeVisible();
    await expect(highlight).toHaveText("second");
    // #1781: the real browser resolves the binding 4a/4b light-mode open treatment — including
    // the non-layout-consuming hairline — rather than the older saturated amber/border-bottom.
    await expect(highlight).toHaveCSS("background-color", "rgb(251, 243, 225)");
    await expect(highlight).toHaveCSS("box-shadow", "rgb(224, 201, 140) 0px 1px 0px 0px");
    await expect(highlight).toHaveCSS("border-bottom-width", "0px");

    // Replace the buffer through the real editor so the live decoration is invalidated, then save
    // with FR-ED-2's opt-out. The backend re-resolves the persisted raw-disk anchor at offset 13;
    // the post-save seed must project it back to CM6 position 12 instead of drawing "econd ".
    await visibleEditor(page).click();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.type("hello world\nsecond line\nsaved");
    await page.keyboard.press(`${mod}+s`);
    await expect.poll(() => project.readSaved()).toBe("hello world\r\nsecond line\r\nsaved");

    highlight = page.locator(".cm-commentHighlight", { hasText: "second" });
    await expect(highlight).toBeVisible();
    await expect(highlight).toHaveText("second");
    const popover = await openCommentThread(page, "second");
    await expect(popover).toContainText("Check this word.");
    await expect(highlight).toHaveClass(/cm-commentHighlight-selected/);
    await expect(highlight).toHaveCSS("background-color", "rgb(225, 224, 248)");
    await expect(highlight).toHaveCSS("box-shadow", "rgb(161, 156, 233) 0px 1px 0px 0px");

    await popover.getByRole("button", { name: "Close" }).click();

    await expect(highlight).not.toHaveClass(/cm-commentHighlight-selected/);
    await expect(highlight).toHaveCSS("background-color", "rgb(251, 243, 225)");
  });

  test("Address with AI on a single open thread: agent delivers a change + reply -> addressed — pending review -> Accept resolves the thread (FR-CMT-2/3)", async ({
    page,
  }) => {
    const content = "Hello brave world, and cheerful clouds today.\n";
    project = createFixtureProject(content);
    const offset = content.indexOf("brave");
    const created = await createComment(
      project.root,
      project.path,
      "reviewer",
      "Prefer a stronger adjective here.",
      { content, utf16Offset: offset, utf16Length: "brave".length },
      0,
    );
    const threadId = created[0].id;

    await openDoc(page);
    const clock = commentClock(page);

    const highlight = page.locator(".cm-commentHighlight", { hasText: "brave" });
    await expect(highlight).toBeVisible();
    await highlight.click();

    const popover = commentThreadDialog(page);
    await expect(popover).toContainText("Prefer a stronger adjective here.");
    await expect(popover).toContainText("Open");

    const addressedAt = await clock.advance();
    await addressWithAIWhileInFlight(page, popover, threadId, async () => {
      // #1122/#1131: a run in flight with nothing delivered yet reads Working, never the completed
      // Addressed — pending claim — that claim is only true once a delivery lands (below). The
      // negative assertions are the ones that would have caught #1122 in the first place: no
      // "Addressed" claim, no count, while nothing has been delivered.
      await expect(popover).toContainText(
        "Addressing with AI — you can edit or delete this comment once the run finishes.",
      );
      await expect(popover).not.toContainText("Addressed");
      await expect(popover).not.toContainText("pending review");
      // #1380: this thread has no earlier delivery, so no linked-change count or [Go to →] renders
      // at all while Working — not just unattributed text, no attributed block either.
      await expect(popover).not.toContainText("from Agent");
      await expect(popover.getByRole("button", { name: "Go to →" })).toHaveCount(0);
    });

    await linkChanges(project.root, project.path, threadId, "agent", addressedAt + 1, [
      "chg-e2e-1",
      "chg-e2e-2",
    ]);
    await replyToComment(
      project.root,
      project.path,
      threadId,
      "agent",
      "Replaced 'brave' with 'valiant'.",
      false,
      false,
      addressedAt + 2,
    );

    await reopenAfterBackendChange(page);
    const clockAfterReload = commentClock(page, addressedAt + 2);
    const delivered = await openCommentThread(page, "brave");
    await expect(delivered).toContainText("Addressed — pending review.");
    await expect(delivered).toContainText("Replaced 'brave' with 'valiant'.");
    await expect(delivered).toContainText("2 linked changes");
    await expect(delivered.getByRole("button", { name: "Resolve — 2 linked changes still to decide" })).toBeDisabled();

    await clockAfterReload.advance();
    await delivered.getByRole("button", { name: "Accept both" }).click();
    await expect(delivered).toContainText("Resolved");
  });

  test("a failed run observed through /run_state clears its addressed thread (#1812/#1826)", async ({
    page,
  }) => {
    const backgroundContent = "Hello background world.\n";
    project = createFixtureProject(backgroundContent);
    const created = await createComment(
      project.root,
      project.path,
      "reviewer",
      "Strengthen this wording.",
      {
        content: backgroundContent,
        utf16Offset: backgroundContent.indexOf("background"),
        utf16Length: "background".length,
      },
      0,
    );
    const threadId = created[0].id;

    await openDoc(page);
    const clock = commentClock(page);
    const popover = await openCommentThread(page, "background");
    const runCards = page.locator('[data-card-kind="agent-working"]');
    const priorRunCards = await runCards.count();
    await clock.advance();
    await popover.getByRole("button", { name: "Address with AI" }).click();
    await expect(runCards).toHaveCount(priorRunCards + 1);
    await expect(runCards.last()).toContainText("Agent stopped unexpectedly");
    await expect
      .poll(async () => {
        const [thread] = await loadCommentThreads(project.root, project.path);
        return thread.pending_run;
      })
      .toBeNull();
    const [concluded] = await loadCommentThreads(project.root, project.path);
    expect(concluded.id).toBe(threadId);
    await reopenAfterBackendChange(page);
    const concludedPopover = await openCommentThread(page, "background");
    await expect(concludedPopover).toContainText("Address run failed — nothing proposed for this comment.");
  });

  test("rejecting the linked change reopens the thread and [Try again — add guidance…] re-delegates (FR-CMT-2/3/7)", async ({
    page,
  }) => {
    const content = "Hello brave world, and cheerful clouds today.\n";
    project = createFixtureProject(content);
    const offset = content.indexOf("cheerful");
    const created = await createComment(
      project.root,
      project.path,
      "reviewer",
      "Is this word too casual?",
      { content, utf16Offset: offset, utf16Length: "cheerful".length },
      0,
    );
    const threadId = created[0].id;

    await openDoc(page);
    const clock = commentClock(page);
    const addressPopover = await openCommentThread(page, "cheerful");
    const addressedAt = await clock.advance();
    const firstAddress = await addressWithAIWhileInFlight(page, addressPopover, threadId, async () => {
      // #1122: nothing delivered yet — Working, not the completed Addressed — pending claim.
      await expect(addressPopover).toContainText(
        "Addressing with AI — you can edit or delete this comment once the run finishes.",
      );
      await expect(addressPopover).not.toContainText("Addressed — pending review.");
    });

    await linkChanges(project.root, project.path, threadId, "agent", addressedAt + 1, ["chg-e2e-3"]);
    await replyToComment(
      project.root,
      project.path,
      threadId,
      "agent",
      "Replaced 'cheerful' with 'gathering'.",
      false,
      false,
      addressedAt + 2,
    );

    await reopenAfterBackendChange(page);
    const clockAfterReload = commentClock(page, addressedAt + 2);
    const popover = await openCommentThread(page, "cheerful");
    await expect(popover).toContainText("1 linked change");

    await clockAfterReload.advance();
    await popover.getByRole("button", { name: "Reject" }).click();
    await expect(popover).toContainText("Reopened");

    await popover.getByRole("button", { name: "Try again — add guidance…" }).click();
    await popover.getByLabel("Guidance for re-delegation").fill("Keep 'cheerful' — just fix the comma splice.");
    await clockAfterReload.advance();
    await popover.getByRole("button", { name: "Try again", exact: true }).click();

    // The D23 provider can fail between two DOM assertions. Its terminal transition correctly
    // clears the Working-only guidance line, so prove re-delegation at the durable TD-4 event seam.
    // This also distinguishes a fresh Address from the old run's failure note still on the card.
    await expect.poll(() => addressEvents(threadId).length).toBe(2);
    const [recordedFirst, reDelegation] = addressEvents(threadId);
    expect(recordedFirst.run_id).toBe(firstAddress.run_id);
    expect(reDelegation.guidance).toBe("Keep 'cheerful' — just fix the comma splice.");
    expect(reDelegation.run_id).not.toBe(firstAddress.run_id);
    await expect.poll(async () => (await loadCommentThreads(project.root, project.path))[0].concluded_run)
      .toMatchObject({ run_id: reDelegation.run_id, outcome: "failed" });
    await expect(popover).toContainText("Address run failed — nothing proposed for this comment.");
    await expect(popover).not.toContainText("Addressed — pending review.");
  });

  test("the agent may defend without editing — the thread stays open and labeled distinctly instead of swept into an accept (FR-CMT-4)", async ({
    page,
  }) => {
    const content = "Hello brave world, and cheerful clouds today.\n";
    project = createFixtureProject(content);
    const offset = content.indexOf("cheerful");
    const created = await createComment(
      project.root,
      project.path,
      "reviewer",
      "\"cheerful clouds\" — intentional?",
      { content, utf16Offset: offset, utf16Length: "cheerful".length },
      0,
    );
    const threadId = created[0].id;

    await openDoc(page);
    const clock = commentClock(page);
    const addressPopover = await openCommentThread(page, "cheerful");
    const addressedAt = await clock.advance();
    await addressWithAIWhileInFlight(page, addressPopover, threadId, async () => {
      // #1122: nothing delivered yet — Working, not the completed Addressed — pending claim.
      await expect(addressPopover).toContainText(
        "Addressing with AI — you can edit or delete this comment once the run finishes.",
      );
      await expect(addressPopover).not.toContainText("Addressed — pending review.");
    });

    // The agent judges the text correct and defends instead of editing (FR-CMT-4) — no
    // `linkChanges` call, published so an external reviewer would see it too (D20).
    await replyToComment(
      project.root,
      project.path,
      threadId,
      "agent",
      "The personification is intentional — keeping it.",
      true,
      true,
      addressedAt + 1,
    );

    await reopenAfterBackendChange(page);
    const popover = await openCommentThread(page, "cheerful");

    // Defended, never swept into "addressed" or "resolved": the thread reads Open again, exactly
    // as ux-design.md J4 describes ("thread stays open ... you resolve or overrule").
    await expect(popover.locator(".comment-thread-card__state")).toHaveText("Open");
    await expect(popover).toContainText("defended — no change proposed");
    await expect(popover).toContainText("published to reviewer");
    await expect(popover).toContainText("The personification is intentional — keeping it.");
    // Still addressable — a defense is not a dead end.
    await expect(popover.getByRole("button", { name: "Address with AI" })).toBeVisible();
  });

  test("batch: [Address all… ▾] transitions every open thread under one run and deciding one comment's delivery resolves it individually (FR-CMT-5/D8)", async ({
    page,
  }) => {
    const content = "Hello brave world, and cheerful clouds today.\n";
    project = createFixtureProject(content);
    const braveOffset = content.indexOf("brave");
    const cheerfulOffset = content.indexOf("cheerful");
    await createComment(
      project.root,
      project.path,
      "reviewer",
      "finding A",
      { content, utf16Offset: braveOffset, utf16Length: "brave".length },
      0,
    );
    await createComment(
      project.root,
      project.path,
      "reviewer",
      "finding B",
      { content, utf16Offset: cheerfulOffset, utf16Length: "cheerful".length },
      1,
    );

    await openDoc(page);
    const clock = commentClock(page);
    await clock.advance();

    // J4-Q1: the trigger opens with no filter pre-applied — the default target is every open thread.
    await page.getByRole("button", { name: /Address all/ }).click();
    await page.getByRole("button", { name: /^Address \d+ comments?$/ }).click();

    // FR-AGENT-6: the run's own accounting, named on the header (scoped past the unrelated
    // editor-only-mode status chip — `role="status"` is not unique on this page).
    await expect(page.locator(".batch-address-status")).toContainText("2 addressed");

    // Neither thread reads Working (issue #1778, ux-design.md §2 "Batch … Working means started,
    // not targeted", UXR-Q10/#1122): dispatching the batch *targets* both threads — FR-AGENT-6's
    // "addressed" here means the batch's own transition landed, not that any per-thread work
    // began — but this build has no per-thread signal to say either one has actually started, so
    // neither may claim it. Both stay Open, and the run's own header accounting above remains the
    // only *progress* surface this mode can honestly offer. §2's rung line (issue #2228) says a
    // run holds the comment while claiming no activity, so it adds no progress claim here either.
    //
    // **It is rendered at this point, and deliberately not asserted.** To see that for yourself,
    // log `page.getByText("In an agent run — it already has this comment as written; you can edit
    // or delete it once the run finishes.").count()` and `loadCommentThreads(project.root,
    // project.path)` here, then run `npx playwright test --grep "batch: .Address all"`: both cards
    // carry rung 2 verbatim, with both threads held by a live unstarted run (`pending_run` set,
    // `pending_run_started: false`, `concluded_run: null`). So the reason not to assert it is
    // *not* that the state is unreachable. It is that the state is **timed**:
    // under D23 the failure conclusion arrives on the `/run_state` poll, which
    // `timeline/agentActivity.ts` wakes `POLL_INTERVAL_MS` (50 ms) after `start_run`, so an
    // assertion here would race that timer rather than wait on a condition — the flake-by-
    // construction the test plan's *Determinism discipline* forbids ("all e2e waits
    // condition-based"). Thread B then lands on §2's exit table, which is what the assertions
    // below pin.
    //
    // Rungs 1-2 are covered where they can be driven deterministically instead:
    // `comments/CommentThreadCard.test.tsx` and `editor/CommentPopover.test.tsx` for the two
    // surfaces, and `timeline/TimelinePanel.batchAddress.test.tsx` for a real panel composition
    // that discriminates rung 1 from rung 2 off `start_run`'s `queuedPosition`. The matrix rows
    // claim `vitest` only, so nothing there over-claims an e2e assertion that does not exist.
    await expect(page.locator(".cm-commentHighlight-working")).toHaveCount(0);
    await expect(page.locator(".cm-commentHighlight-open")).toHaveCount(2);
    await expect(page.locator(".cm-commentHighlight-addressed-pending")).toHaveCount(0);

    // J4 Batch's own reviewable artifact (#537): the run also raises one grouped-by-comment
    // change-set card in the timeline, with one `▸` group per addressed comment — the deferred
    // half of P2b-3b's rendering (#398/#351) a real batch outcome now actually reaches, not just
    // the header's own accounting above. Each group carries no changes yet — nothing spawns the
    // provider run behind a batch address and ties its delivery back to a comment id yet
    // (P2a-15's own scope) — so it stays listed at a `(0)` count with no Accept/Reject controls
    // (review finding #537: a change-less group must still name the comment it addressed, not
    // vanish for having nothing to sweep) — the honest shape the wiring produces today.
    const batchCard = page.locator('[data-card-kind="change-set"]');
    await expect(batchCard).toContainText("ADDRESSED 2 COMMENTS · Agent");
    await expect(batchCard).toContainText("0 changes · 0 replies · 0 defenses");
    await expect(batchCard.getByText("brave (0)")).toBeVisible();
    await expect(batchCard.getByText("cheerful (0)")).toBeVisible();
    // Nothing to sweep yet — no per-group Accept/Reject rendered on either group ("Accept all" — the
    // footer's own sweep control, still present and unaffected — is an exact-name substring match
    // this scoping must not collide with).
    await expect(batchCard.getByRole("button", { name: "Accept", exact: true })).toHaveCount(0);
    await expect(batchCard.getByRole("button", { name: "Reject", exact: true })).toHaveCount(0);

    const threads = await loadCommentThreads(project.root, project.path);
    const threadA = threads.find((t) => t.body === "finding A");

    // The agent's delivery lands for comment A only — B stays pending with nothing linked, exactly
    // FR-AGENT-6/J4's "deciding one comment's group resolves that thread individually."
    const deliveredAt = await clock.advance();
    await linkChanges(project.root, project.path, threadA.id, "agent", deliveredAt + 1, ["chg-e2e-batch-1"]);
    await replyToComment(
      project.root,
      project.path,
      threadA.id,
      "agent",
      "Replaced 'brave' with 'valiant'.",
      false,
      false,
      deliveredAt + 2,
    );

    await reopenAfterBackendChange(page);
    const clockAfterReload = commentClock(page, deliveredAt + 2);

    const popoverA = await openCommentThread(page, "brave");
    await expect(popoverA).toContainText("1 linked change");
    await clockAfterReload.advance();
    await popoverA.getByRole("button", { name: "Accept" }).click();
    await expect(popoverA).toContainText("Resolved");
    await popoverA.getByRole("button", { name: "Close" }).click();

    // D23's provider guard fails the real batch run without spawning anything. The production
    // `/run_state` subscriber therefore clears B's pending marker and restores its retry action;
    // this is a terminal outcome, never an Addressed or Working claim.
    const popoverB = await openCommentThread(page, "cheerful");
    await expect(popoverB.locator('[data-thread-state="open"]')).toBeVisible();
    await expect(popoverB.getByRole("button", { name: "Address with AI" })).toBeVisible();
    await expect(popoverB).toContainText("Address run failed — nothing proposed for this comment.");
    await expect(popoverB).not.toContainText(
      "Addressing with AI — you can edit or delete this comment once the run finishes.",
    );
    await expect(popoverB).not.toContainText("Addressed — pending review.");
    await expect(popoverB.locator(".comment-thread-card__linked-changes")).toHaveCount(0);
  });

  test("#2258 a run absent from the queued set stays on rung 2 in Timeline and popover", async ({ page }) => {
    const content = "Hello brave world, and cheerful clouds today.\n";
    project = createFixtureProject(content);
    for (const [index, word] of ["brave", "cheerful"].entries()) {
      await createComment(project.root, project.path, "reviewer", `finding ${word}`,
        { content, utf16Offset: content.indexOf(word), utf16Length: word.length }, index);
    }
    await openDoc(page);

    // Hold only the next status *response*. The real Rust batch command still produces the
    // nonqueued run and the real frontend still renders its response. This replaces push cadence
    // with a controlled HTTP cadence (test-plan §7b), keeping D23's fast provider failure from
    // erasing the transient targeted rung before the assertions can read it.
    const polls = await holdRunStatePolls(page);
    try {
      await page.getByRole("button", { name: /Address all/ }).click();
      await page.getByRole("button", { name: /^Address \d+ comments?$/ }).click();
      await expect(page.locator(".batch-address-status")).toContainText("2 addressed");
      await polls.held;
      const rung2 = "In an agent run — it already has this comment as written; you can edit or delete it once the run finishes.";
      const rung1 = "Queued behind an agent run — it already has this comment as written; you can edit or delete it once the run finishes.";
      await expect(page.locator('.timeline-panel [data-card-kind="comment"] [data-ladder-rung="targeted"]')).toHaveCount(2);
      await expect(page.getByText(rung1)).toHaveCount(0);
      await expect(page.locator('[data-card-kind="agent-working"]').last().getByRole("button", { name: "Stop" })).toBeVisible();
      const popover = await openCommentThread(page, "brave");
      await expect(popover).toContainText(rung2);
    } finally {
      await polls.release();
    }
  });

  test("#2539 collapsed batch reveals the toolbar chooser and focuses the admitted run with J13 context", async ({ page }) => {
    const content = "Hello brave world, and cheerful clouds today.\n";
    project = createFixtureProject(content);
    for (const [index, word] of ["brave", "cheerful"].entries()) {
      await createComment(project.root, project.path, "reviewer", `finding ${word}`,
        { content, utf16Offset: content.indexOf(word), utf16Length: word.length }, index);
    }
    await openDoc(page, { pauseAutosave: true });
    const clock = commentClock(page);
    await clock.advance();
    await page.locator(".cm-content:visible").click();
    await page.keyboard.type(" changed");
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    await page.getByRole("button", { name: "Hide Timeline" }).click();
    const toolbar = page.getByRole("toolbar", { name: "Editor view controls" });
    await toolbar.getByRole("button", { name: /Address all/ }).click();
    const submit = page.getByRole("button", { name: "Address 2 comments" });
    await expect(submit).toBeVisible();
    const chooserPlacement = await submit.evaluate((button) => {
      const panel = button.closest(".batch-address__panel");
      const toolbar = document.querySelector(".view-mode-toolbar");
      const bounds = button.getBoundingClientRect();
      const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      return {
        bottom: panel.getBoundingClientRect().bottom,
        toolbarBottom: toolbar.getBoundingClientRect().bottom,
        hitButton: button === hit || button.contains(hit),
      };
    });
    expect(chooserPlacement.bottom).toBeGreaterThan(chooserPlacement.toolbarBottom);
    expect(chooserPlacement.hitButton).toBe(true);
    await submit.click();
    const run = page.locator('[data-card-kind="agent-working"]');
    await expect(run).toBeVisible();
    await expect(run).toBeFocused();
    const readLanding = () => run.evaluate((card) => {
      const viewport = card.closest('[data-testid="virtual-list"]');
      return {
        bottomGap: viewport.getBoundingClientRect().bottom - card.getBoundingClientRect().bottom,
        outlineOffset: getComputedStyle(card).outlineOffset,
      };
    });
    await expect.poll(async () => (await readLanding()).bottomGap).toBeGreaterThanOrEqual(11);
    const landing = await readLanding();
    expect(landing.bottomGap).toBeLessThanOrEqual(13);
    expect(landing.outlineOffset).toBe("2px");
    await expect(run).toContainText("↑ OUT");
    await expect(run).toContainText("carried notes.md as edited");
    await expect(page.getByRole("region", { name: "Comments" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "All", exact: true })).toHaveAttribute("aria-pressed", "true");
  });

  test("#2539 collapsed batch remains reachable from the narrow toolbar overflow", async ({ page }) => {
    const content = "Hello brave world, and cheerful clouds today.\n";
    project = createFixtureProject(content);
    for (const [index, word] of ["brave", "cheerful"].entries()) {
      await createComment(project.root, project.path, "reviewer", `finding ${word}`,
        { content, utf16Offset: content.indexOf(word), utf16Length: word.length }, index);
    }
    await openDoc(page);
    await commentClock(page).advance();
    await page.getByRole("button", { name: "Hide Timeline" }).click();
    const toolbar = page.getByRole("toolbar", { name: "Editor view controls" });
    await toolbar.evaluate((element) => { element.style.width = "330px"; });
    const more = toolbar.getByRole("button", { name: "More editor controls" });
    await expect(more).toBeVisible();
    await more.focus();
    await page.keyboard.press("ArrowDown");
    const overflow = toolbar.getByRole("dialog", { name: "More editor controls" });
    await expect(overflow).toBeVisible();
    const trigger = overflow.getByRole("button", { name: /Address all/ });
    await trigger.click();
    const submit = page.getByRole("button", { name: "Address 2 comments" });
    await expect(submit).toBeVisible();
    await submit.click();
    const run = page.locator('[data-card-kind="agent-working"]');
    await expect(run).toBeVisible();
    await expect(run).toBeFocused();
  });

  test("batch interrupted mid-run: the run card names the partial write and retry includes the terminal-cleared comment (#1826/FR-AGENT-6)", async ({
    page,
  }) => {
    const content = "Hello brave world, and cheerful clouds today.\n";
    project = createFixtureProject(content);
    for (const [i, word] of ["brave", "cheerful", "clouds"].entries()) {
      await createComment(
        project.root,
        project.path,
        "reviewer",
        `finding on ${word}`,
        { content, utf16Offset: content.indexOf(word), utf16Length: word.length },
        i,
      );
    }

    await openDoc(page);
    const clock = commentClock(page);
    await clock.advance();

    // The run dies after its first comment lands: the sidecar it is appending to goes read-only in
    // the window between two appends, so the second append hits a real write failure (see this
    // describe's own note — the fault is real, the batch's code path is the production one).
    await armBatchAddressFault(1);

    await page.getByRole("button", { name: /Address all/ }).click();
    await page.getByRole("button", { name: /^Address 3 comments$/ }).click();

    // FR-AGENT-6's whole point, at the surface the user actually reads: partial, and honest about
    // it. Not "3 addressed", not a silent failure that reads as though everything was handled.
    const firstStatus = page.locator(".batch-address-status").filter({ hasText: "Batch 1" });
    await expect(firstStatus).toContainText("1 addressed");
    await expect(firstStatus).toContainText("2 untouched");
    await expect(firstStatus).toContainText("stopped early");

    // Landing the batch's own transition is not per-thread start evidence (issue #1778): this
    // build has no per-thread signal here either, so the one comment the batch reached before the
    // fault still reads Open, exactly like the two it never reached — never the completed
    // Addressed — pending claim, and never a false Working claim FR-AGENT-6's "addressed" bucket
    // does not warrant on its own.
    await expect(page.locator(".cm-commentHighlight-working")).toHaveCount(0);
    await expect(page.locator(".cm-commentHighlight-open")).toHaveCount(3);
    await expect(page.locator(".cm-commentHighlight-addressed-pending")).toHaveCount(0);
    await expect(page.locator('[data-card-kind="change-set"]')).toContainText(
      "ADDRESSED 1 COMMENT · Agent",
    );

    // An interruption is recoverable, not a dead end. By the retry, `/run_state` has also observed
    // the first run's safe provider failure and cleared its one pending marker, so all three open
    // threads are eligible again. Reopen the chooser after the first submission closed it, then
    // assert that settled UI state directly: clicking the transient two-comment label raced the
    // polling fold and could miss the retry entirely.
    await clock.advance();
    await page.getByRole("button", { name: /Address all/ }).click();
    await page.getByRole("button", { name: /^Address 3 comments$/ }).click();
    const retryStatus = page.locator(".batch-address-status").filter({ hasText: "Batch 2" });
    await expect(retryStatus).toContainText("3 addressed");
    await expect(retryStatus).not.toContainText("untouched");
    // All three remain Open: neither safe driver failure may leave a false Working claim.
    await expect(page.locator(".cm-commentHighlight-working")).toHaveCount(0);
    await expect(page.locator(".cm-commentHighlight-open")).toHaveCount(3);
    await expect(page.locator(".cm-commentHighlight-addressed-pending")).toHaveCount(0);
    await expect(page.locator('[data-card-kind="change-set"]').last()).toContainText(
      "ADDRESSED 3 COMMENTS · Agent",
    );
  });

  test("a comment made on an edited buffer is marked in the document once the save names the buffer's revision (#1121)", async ({
    page,
  }) => {
    // The reported journey, end to end against the real backend: type, comment on the *unsaved*
    // text, save. Until the save there is no revision naming the buffer, so the thread's stored
    // offsets describe the older on-disk text and the shell refuses to draw them (P2 — never a
    // confidently-wrong position). `save_document` returning the revision it wrote is what re-opens
    // that seam, and the re-read that rides it re-anchors the thread against the bytes that landed.
    const content = "Hello brave world, and cheerful clouds today.\n";
    project = createFixtureProject(content);

    // Only the explicit Cmd/Ctrl+S below saves — otherwise the 1 s autosave would decide when the
    // highlight appears (test-plan §7: no wall-clock races).
    await openDoc(page, { pauseAutosave: true });
    const clock = commentClock(page);
    await clock.advance();

    // An edit at the *start* of the document: every stored offset after it now names different
    // text, so nothing here can pass by leaving the pre-edit positions in place.
    await page.locator(".cm-content").click();
    await page.keyboard.press(`${mod}+Home`);
    await page.keyboard.type("Note: ");

    // Select the word just typed and comment on it through the real UI.
    await page.keyboard.press(`${mod}+Home`);
    for (let i = 0; i < 4; i += 1) await page.keyboard.press("Shift+ArrowRight");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    const composer = page.getByRole("dialog");
    await composer.getByLabel("Comment").fill("Anchored while this buffer was unsaved.");
    await composer.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // The bug as reported: nothing marks the anchored text yet — the thread was resolved against
    // the on-disk text, which has no "Note" in it at all.
    await expect(page.locator(".cm-commentHighlight")).toHaveCount(0);

    // Save is a CodeMirror binding, so the caret has to be back in the document — the popover took
    // focus when it opened. Click the empty final line: the selected word's Comment control remains
    // visible and can cover the content container's center in the 236px + 372px shell.
    await page.locator(".cm-line").last().click({ position: { x: 1, y: 1 } });
    await page.keyboard.press(`${mod}+s`);
    await expect.poll(() => project.readSaved()).toBe(`Note: ${content}`);

    const highlight = page.locator(".cm-commentHighlight", { hasText: "Note" });
    await expect(highlight).toHaveText("Note");
    // ...and it is the route back into the thread (`CommentPopover`'s own "re-select through its
    // anchor" contract, which until now had no anchor to re-select through).
    await highlight.click();
    await expect(commentThreadDialog(page)).toContainText("Anchored while this buffer was unsaved.");
  });
});

test.describe("J9 project-open status clipping (13g)", () => {
  let project;

  test.afterEach(async ({ page }) => {
    if (project !== undefined) {
      await project.cleanup(page);
      project = undefined;
    }
  });

  test("a short project name stays adjacent to the fixed outcome sentence", async ({ page }) => {
    project = createFixtureProject("# Existing notes\n");
    const shortRoot = join(project.root, "plan");
    mkdirSync(shortRoot);
    writeFileSync(join(shortRoot, "notes.md"), "# Notes\n");
    await reportPlatform(page, "Win32");
    await page.goto("/");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), shortRoot);
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), shortRoot);

    const band = page.locator(".shell-status--project-open");
    await expect(band).toContainText("plan is already open in this window.");
    const gap = await band.evaluate((element) => {
      const name = element.querySelector(".project-open-status__name");
      const suffixes = element.querySelectorAll(".project-open-status__fixed");
      const suffix = suffixes[suffixes.length - 1];
      const text = name?.firstChild;
      if (!name || !suffix || !text) throw new Error("Outcome name or suffix is missing");
      const textRange = document.createRange();
      textRange.selectNodeContents(text);
      return suffix.getBoundingClientRect().left - textRange.getBoundingClientRect().right;
    });
    expect(gap).toBeLessThanOrEqual(1);
  });

  test("failure reason yields before the name and fixed words while actions remain fixed", async ({ page }) => {
    project = createFixtureProject("# Existing notes\n");
    await reportPlatform(page, "Win32");
    await page.goto("/");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);
    const missingRoot = join(project.root, "missing-long-name-for-clipping-2026-q1-partner-launch-messaging");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), missingRoot);

    const band = page.locator(".shell-status--project-open");
    await expect(band).toContainText("That folder isn’t available to Emend.");
    for (const width of [700, 520, 420]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await band.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const name = element.querySelector(".project-open-status__name");
        const suffixes = element.querySelectorAll(".project-open-status__fixed");
        const prefix = suffixes[0];
        const suffix = suffixes[suffixes.length - 1];
        const reason = element.querySelector(".project-open-status__detail");
        const actions = element.querySelector(".shell-status__actions");
        const message = element.querySelector(".shell-status__message");
        if (!prefix || !name || !suffix || !reason || !actions || !message) throw new Error("Failure status runs are missing");
        return {
          height: rect.height,
          right: rect.right,
          nameWidth: name.getBoundingClientRect().width,
          nameTextWidth: (() => {
            const range = document.createRange();
            range.selectNodeContents(name);
            return range.getBoundingClientRect().width;
          })(),
          nameText: name.textContent,
          prefixRight: prefix.getBoundingClientRect().right,
          prefixTextToNameGap: (() => {
            const text = prefix.firstChild;
            if (!text || text.nodeType !== Node.TEXT_NODE || !text.textContent?.endsWith(" ")) {
              throw new Error("Expected the fixed prefix to end in a rendered space");
            }
            const range = document.createRange();
            range.setStart(text, 0);
            range.setEnd(text, text.textContent.length - 1);
            return name.getBoundingClientRect().left - range.getBoundingClientRect().right;
          })(),
          suffixRight: suffix.getBoundingClientRect().right,
          suffixToReasonGap: reason.getBoundingClientRect().left - suffix.getBoundingClientRect().right,
          suffixText: suffix.textContent,
          messageRight: message.getBoundingClientRect().right,
          reasonWidth: reason.getBoundingClientRect().width,
          reasonText: reason.textContent,
          actionsRight: actions.getBoundingClientRect().right,
          nameOverflow: getComputedStyle(name).overflow,
          nameEllipsis: getComputedStyle(name).textOverflow,
        };
      });
      expect(geometry.height).toBe(46);
      expect(geometry.nameText).toBe("missing-long-name-for-clipping-2026-q1-partner-launch-messaging");
      expect(geometry.reasonText).toBe(" That folder isn’t available to Emend.");
      expect(geometry.suffixText).toBe(".");
      expect(geometry.prefixRight).toBeLessThanOrEqual(geometry.messageRight);
      expect(geometry.actionsRight).toBeLessThanOrEqual(geometry.right - 13);
      expect(geometry.nameOverflow).toBe("hidden");
      expect(geometry.nameEllipsis).toBe("ellipsis");
      if (width === 700) {
        expect(geometry.suffixToReasonGap).toBeGreaterThan(2);
        expect(geometry.suffixToReasonGap).toBeLessThan(7);
        expect(geometry.reasonWidth).toBeGreaterThan(0);
        expect(geometry.nameTextWidth).toBeLessThanOrEqual(geometry.nameWidth + 0.1);
      }
      if (width === 520) {
        expect(geometry.suffixRight).toBeLessThanOrEqual(geometry.messageRight);
        expect(geometry.reasonWidth).toBe(0);
        expect(geometry.nameWidth).toBeGreaterThan(160);
      }
      // 420px is the first step at which this copy's name reaches the 160px floor.
      if (width === 420) {
        expect(geometry.prefixTextToNameGap).toBeGreaterThan(2);
        expect(geometry.prefixTextToNameGap).toBeLessThan(7);
        // CJ chose the written 160px floor for 13g; the period clips only after that floor.
        expect(geometry.nameWidth).toBe(160);
        expect(geometry.reasonWidth).toBe(0);
        expect(geometry.suffixRight).toBeGreaterThan(geometry.messageRight);
      }
    }
  });
});

test.describe("P2b-11b J2 — brainstorm to draft materializes", () => {
  // #413 hasn't wired a live run's MCP server yet (`commands::agent::claude_invocation`'s own doc:
  // "no `McpServer` is wired in yet"), so nothing today can spawn a real agent turn that calls
  // `create_document` for itself — exactly the gap P2b-11c's own suite above already named for
  // `address_with_ai`. `documentBirthDriver.mjs`'s `createDocument` stands in for that turn: the
  // real `agent::state::McpContext::create_document` write, path confinement and identity mint
  // included, over the D23 headless test driver (`commands::agent::create_document_direct`) — never
  // a mock of the tool itself, only its not-yet-wired caller. The real observer publishes the birth
  // through the driver's append-only event log and the mounted production frontend listener.
  // Likewise, entering workshop mode itself needs `openProjectFolder` (mirrors the real
  // "Open a folder…" transition minus the native, unautomatable dialog) rather than `openProject`
  // above, which always names a document and so never lands in workshop mode.
  /** @type {ReturnType<typeof createFixtureProject>} */
  let project;

  test.afterEach(async ({ page }) => {
    if (project !== undefined) {
      await project.cleanup(page);
      project = undefined;
    }
  });

  const windowsRailTheme = {
    name: "Windows",
    navigatorPlatform: "Win32",
    railBackground: "rgb(245, 243, 237)",
    activeBackground: "rgb(228, 233, 239)",
    activeForeground: "rgb(58, 54, 47)",
    darkActiveBackground: "rgb(30, 31, 34)",
    darkActiveForeground: "rgb(230, 231, 234)",
  };
  const macRailTheme = {
    name: "macOS",
    navigatorPlatform: "MacIntel",
    railBackground: "rgb(241, 238, 231)",
    activeBackground: "rgb(79, 70, 229)",
    activeForeground: "rgb(255, 255, 255)",
    darkActiveBackground: "rgb(165, 176, 255)",
    darkActiveForeground: "rgb(16, 19, 26)",
  };

  /**
   * Drives J2 into Missing through the assembled app and real project-files backend, then replaces
   * the retained editor buffer while autosave is provably paused. The returned rail/editor are the
   * same live surfaces every recovery below must restore; no snapshot or IPC response is fabricated.
   *
   * The two intervals are the D23 injectable clocks (test-plan §7). Their defaults keep every
   * recovery below prompt; a caller that is measuring an *ordering* rather than an outcome sets them
   * so the ordering it needs is the one that happens, instead of waiting for one.
   */
  async function openMissingDocument(page, buffer = "Recovered buffer", clocks = {}) {
    const { autosaveMs = 50, pollMs = 50 } = clocks;
    project = createFixtureProject("Original disk bytes");
    await page.goto("/");
    await page.evaluate(
      ({ autosave, poll }) => {
        window.__EMEND_E2E__?.setAutosaveIntervalMs(autosave);
        window.__EMEND_E2E__?.setExternalChangePollMs(poll);
      },
      { autosave: autosaveMs, poll: pollMs },
    );
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    const rail = page.getByRole("complementary", { name: "Project files" });
    const row = rail.getByRole("treeitem", { name: "notes.md" });
    await row.click();
    await expect(page.getByRole("tab", { name: /notes\.md/ })).toBeVisible();
    await expect(row).toHaveAttribute("aria-current", "page");
    const editor = page.locator(".cm-content:visible");
    await expect(editor).toContainText("Original disk bytes");

    project.removeFile();
    await rail.getByRole("button", { name: "Refresh project files" }).click();
    await expect(page.getByRole("button", { name: /Missing on disk: notes\.md/ })).toBeVisible();

    await editor.click();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.type(buffer);
    await expect(editor).toHaveText(buffer);
    expect(existsSync(join(project.root, project.path))).toBe(false);
    return { rail, editor };
  }

  /**
   * Supplies the result of the next native Save panel interaction. This substitutes only the
   * out-of-process OS dialog (test-plan §7b); the click, confinement decision, history move,
   * backend write, tab/rail transition, and autosave remain the production path.
   */
  async function chooseNextSaveAsDestination(page, path) {
    await page.evaluate(
      (destination) => window.__EMEND_E2E__?.setNextSaveAsDialogResult(destination),
      path,
    );
  }

  test("D27 project rail presents the opened folder above Documents and Skills", async ({ page }) => {
    project = createFixtureProject("# Rail header\n");
    await reportPlatform(page, "Win32");
    await page.goto("/");
    await openDocument(page, project);
    const rail = page.getByRole("complementary", { name: "Project files" });
    const folderName = project.root.split(/[\\/]/).filter(Boolean).pop();
    await expect(rail.locator(".project-rail__project-name")).toHaveText(folderName);
    await expect(rail.locator(".project-rail__section-label").first()).toHaveText("DOCUMENTS");
    await expect(rail.locator(".project-rail__section-label").nth(1)).toHaveText("SKILLS");
    await expect(rail).toHaveCSS("width", "236px");
    await expect(rail.locator(".project-rail__project-name")).toHaveCSS("font-size", "12.5px");
    await expect(rail.locator(".project-rail__project-name")).toHaveCSS("color", "rgb(74, 70, 62)");
  });

  test("D27 rail opens discovered skill material and workflow from one tree", async ({ page }) => {
    project = createFixtureProject("# Ordinary notes\n");
    mkdirSync(join(project.root, "claude_skills/review"), { recursive: true });
    mkdirSync(join(project.root, ".claude/skills/audit"), { recursive: true });
    mkdirSync(join(project.root, "workflows"), { recursive: true });
    writeFileSync(
      join(project.root, "claude_skills/review/SKILL.md"),
      "---\nname: Review\ndescription: Review drafts.\n---\n\n# Review body\n",
    );
    writeFileSync(
      join(project.root, ".claude/skills/audit/SKILL.md"),
      "---\nname: Audit\ndescription: Audit sources.\n---\n\n# Audit body\n",
    );
    writeFileSync(join(project.root, "workflows/polish.md"), "# Polish workflow\n");
    await page.goto("/");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    const rail = page.getByRole("complementary", { name: "Project files" });
    await expect(rail.getByRole("tree")).toHaveCount(1);
    const review = rail.getByRole("treeitem", { name: "Review. Review drafts." });
    const audit = rail.getByRole("treeitem", { name: "Audit. Audit sources." });
    const workflow = rail.getByRole("treeitem", { name: "polish. workflows/polish.md" });
    await expect(review).toBeVisible();
    await expect(audit).toBeVisible();
    await expect(workflow).toBeVisible();
    await expect(rail.getByRole("treeitem", { name: "claude_skills" })).toHaveCount(0);
    await expect(rail.getByRole("treeitem", { name: ".claude" })).toHaveCount(0);
    await expect(workflow).not.toHaveAttribute("aria-expanded");

    await review.click();
    await rail.getByRole("treeitem", { name: "claude_skills/review/SKILL.md" }).click();
    await expect(page.locator(".cm-content:visible")).toContainText("Review body");
    await expect(rail.locator('[role="treeitem"][aria-current="page"]')).toHaveCount(1);
    await workflow.click();
    await expect(page.locator(".cm-content:visible")).toContainText("Polish workflow");
    await expect(workflow).toHaveAttribute("aria-current", "page");
    await expect(rail.locator('[role="treeitem"][aria-current="page"]')).toHaveCount(1);
  });

  test("B2 Windows collapsed rail keeps a 44px restore strip", async ({ page }) => {
    project = createFixtureProject("# Rail collapse\n");
    await reportPlatform(page, "Win32");
    await page.goto("/");
    await openDocument(page, project);
    const rail = page.getByRole("complementary", { name: "Project files" });
    await rail.getByRole("button", { name: "Hide project files" }).click();
    await expect(rail).toHaveClass(/project-rail--collapsed/);
    await expect(rail).toHaveCSS("width", "44px");
    const restore = rail.getByRole("button", { name: "Show project files" });
    await expect(restore).toHaveCSS("width", "44px");
    await expect(restore).toHaveCSS("height", "40px");
    await restore.click();
    await expect(rail).toHaveCSS("width", "236px");
    await expect(page.getByRole("tab", { name: /notes\.md/ })).toBeVisible();
  });

  test("project rail follows the app theme on Windows while preserving 3a/3b light colors", async ({
    page,
  }) => {
    await assertProjectRailTheme(page, windowsRailTheme);
  });

  test("project rail follows the app theme on macOS while preserving 3a/3b light colors", async ({
    page,
  }) => {
    await assertProjectRailTheme(page, macRailTheme);
  });

  async function assertProjectRailTheme(page, platform) {
    project = createFixtureProject("# Themed notes\n");
    await reportPlatform(page, platform.navigatorPlatform);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    const rail = page.getByRole("complementary", { name: "Project files" });
    await expect(rail.locator(".project-rail__project-name"))
      .toHaveText(project.root.split(/[\\/]/).filter(Boolean).pop());
    await expect(rail.locator(".project-rail__section-label").first()).toHaveText("DOCUMENTS");
    await expect(rail.locator(".project-rail__section-label").nth(1)).toHaveText("SKILLS");
    const active = rail.getByRole("treeitem", { name: "notes.md" });
    await active.click();
    await expect(active).toHaveAttribute("aria-current", "page");

    await chooseTheme(page, "Light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const light = await projectRailAppearance(rail);
    expect(light).toMatchObject({
      width: "236px",
      railBackground: platform.railBackground,
      railForeground: "rgb(58, 54, 47)",
      border: "rgb(227, 223, 214)",
      headerForeground: "rgb(74, 70, 62)",
      refreshForeground: "rgb(163, 158, 146)",
      activeBackground: platform.activeBackground,
      activeForeground: platform.activeForeground,
      footerForeground: "rgb(140, 135, 121)",
      footerBorder: "rgb(227, 223, 214)",
      footerPadding: "11px 14px",
      footerDot: "rgb(181, 135, 31)",
    });
    if (platform.name === "Windows") {
      expect(light.activeShadow).toContain("rgb(79, 70, 229)");
      expect(light.activeShadow).toContain("inset");
    } else {
      expect(light.activeShadow).toBe("none");
    }

    await chooseTheme(page, "Dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const dark = await projectRailAppearance(rail);
    expect(dark).toMatchObject({
      railBackground: "rgb(38, 40, 44)",
      railForeground: "rgb(230, 231, 234)",
      border: "rgb(58, 61, 66)",
      headerForeground: "rgb(230, 231, 234)",
      refreshForeground: "rgb(154, 160, 166)",
      activeBackground: platform.darkActiveBackground,
      activeForeground: platform.darkActiveForeground,
      footerForeground: "rgb(154, 160, 166)",
      footerBorder: "rgb(58, 61, 66)",
      footerDot: "rgb(252, 211, 77)",
    });
    if (platform.name === "Windows") {
      expect(dark.activeShadow).toContain("rgb(165, 176, 255)");
      expect(dark.activeShadow).toContain("inset");
    } else {
      expect(dark.activeShadow).toBe("none");
    }
  }

  test("project rail stays present from workshop to authoring and keyboard activation uses the real open path", async ({
    page,
  }) => {
    project = createFixtureProject("# Existing notes\n");
    project.addFile("second.md", "# Second document\n");
    project.addFile("source.txt", "context only\n");
    await page.goto("/");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    const rail = page.getByRole("complementary", { name: "Project files" });
    await expect(rail).toBeVisible();
    await expect(page.locator(".app-body")).toHaveClass(/app-body--workshop/);
    await expect(rail.getByRole("treeitem", { name: "source.txt" })).toBeVisible();

    const first = rail.getByRole("treeitem", { name: "notes.md" });
    await first.focus();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("tab", { name: /notes\.md/ })).toBeVisible();
    await expect(page.locator(".cm-content:visible")).toContainText("Existing notes");
    await expect(page.locator(".app-body")).not.toHaveClass(/app-body--workshop/);
    await expect(rail).toBeVisible();
    await expect(first).toHaveAttribute("aria-current", "page");

    await rail.getByRole("treeitem", { name: "second.md" }).click();
    await expect(page.getByRole("tab", { name: /second\.md/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(rail.getByRole("treeitem", { name: "second.md" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await rail.getByRole("treeitem", { name: "source.txt" }).click();
    await expect(page.getByRole("tab", { name: /source\.txt/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".cm-content:visible")).toContainText("context only");
  });

  test("an external write reaches the project rail automatically with no Refresh click", async ({
    page,
  }) => {
    project = createFixtureProject("# Existing notes\n");
    await page.goto("/");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    const rail = page.getByRole("complementary", { name: "Project files" });
    await expect(rail.getByRole("treeitem", { name: "notes.md" })).toBeVisible();

    project.addFile("automatic.md", "# Arrived automatically\n");

    await expect(rail.getByRole("treeitem", { name: "automatic.md" })).toBeVisible();
  });

  test("a real correlated file rename carries the active tab, unsaved buffer, and rail row", async ({
    page,
  }) => {
    project = createFixtureProject("# Draft notes\n");
    await page.goto("/");
    await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(60_000));
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    const rail = page.getByRole("complementary", { name: "Project files" });
    const oldRow = rail.getByRole("treeitem", { name: "notes.md" });
    await oldRow.click();
    await expect(oldRow).toHaveAttribute("aria-current", "page");
    await visibleEditor(page).click();
    await page.keyboard.type("Unsaved before rename. ");
    await expect(page.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute(
      "data-dirty",
      "true",
    );

    renameSync(join(project.root, "notes.md"), join(project.root, "renamed.md"));

    const movedTab = page.getByRole("tab", { name: /renamed\.md/ });
    const movedRow = rail.getByRole("treeitem", { name: "renamed.md" });
    await expect(movedTab).toHaveAttribute("aria-selected", "true");
    await expect(movedTab).toHaveAttribute("data-dirty", "true");
    await expect(visibleEditor(page)).toContainText("Unsaved before rename.");
    await expect(movedRow).toHaveAttribute("aria-current", "page");
    await expect(rail.getByRole("treeitem", { name: "notes.md" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /notes\.md/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Missing on disk/ })).toHaveCount(0);
  });

  test("a clean real file move reloads the destination bytes instead of carrying a stale buffer", async ({
    page,
  }) => {
    project = createFixtureProject("# Before the move\n");
    await page.goto("/");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    const rail = page.getByRole("complementary", { name: "Project files" });
    await rail.getByRole("treeitem", { name: "notes.md" }).click();
    await expect(visibleEditor(page)).toContainText("Before the move");
    await expect(page.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute(
      "data-dirty",
      "false",
    );

    renameSync(join(project.root, "notes.md"), join(project.root, "moved.md"));
    project.overwrite("# Bytes read from the destination\n", "moved.md");

    const movedTab = page.getByRole("tab", { name: /moved\.md/ });
    await expect(movedTab).toHaveAttribute("aria-selected", "true");
    await expect(movedTab).toHaveAttribute("data-dirty", "false");
    await expect(visibleEditor(page)).toContainText("Bytes read from the destination");
    await expect(visibleEditor(page)).not.toContainText("Before the move");
    await expect(rail.getByRole("treeitem", { name: "moved.md" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(rail.getByRole("treeitem", { name: "notes.md" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Missing on disk/ })).toHaveCount(0);
  });

  test("a real directory rename carries an open descendant and its expanded folder", async ({
    page,
  }) => {
    project = createFixtureProject("# Root notes\n");
    mkdirSync(join(project.root, "drafts"), { recursive: true });
    project.addFile("drafts/outline.md", "# Nested outline\n");
    await page.goto("/");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    const rail = page.getByRole("complementary", { name: "Project files" });
    const drafts = rail.getByRole("treeitem", { name: "drafts", exact: true });
    await drafts.click();
    await expect(drafts).toHaveAttribute("aria-expanded", "true");
    await rail.getByRole("treeitem", { name: "drafts/outline.md" }).click();
    await expect(page.getByRole("tab", { name: /drafts\/outline\.md/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await rail.getByRole("treeitem", { name: "notes.md" }).click();
    await expect(page.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("tab", { name: /drafts\/outline\.md/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await expect(drafts).toHaveAttribute("aria-expanded", "true");

    renameSync(join(project.root, "drafts"), join(project.root, "archive"));

    const archive = rail.getByRole("treeitem", { name: "archive", exact: true });
    const movedRow = rail.getByRole("treeitem", { name: "archive/outline.md" });
    await expect(archive).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("tab", { name: /archive\/outline\.md/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await expect(page.getByRole("tab", { name: /notes\.md/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(movedRow).not.toHaveAttribute("aria-current");
    await expect(rail.getByRole("treeitem", { name: "drafts", exact: true })).toHaveCount(0);
    await expect(rail.getByRole("treeitem", { name: "drafts/outline.md" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Missing on disk/ })).toHaveCount(0);
  });

  test("an uncorrelated delete-create with the same filename leaves the old tab Missing", async ({
    page,
  }) => {
    project = createFixtureProject("# Root notes\n");
    mkdirSync(join(project.root, "drafts"), { recursive: true });
    project.addFile("drafts/outline.md", "# Original identity\n");
    await page.goto("/");
    await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(60_000));
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    const rail = page.getByRole("complementary", { name: "Project files" });
    await rail.getByRole("treeitem", { name: "drafts", exact: true }).click();
    await rail.getByRole("treeitem", { name: "drafts/outline.md" }).click();
    await visibleEditor(page).click();
    await page.keyboard.type("Unsaved on the original. ");
    await expect(page.getByRole("tab", { name: /drafts\/outline\.md/ })).toHaveAttribute(
      "data-dirty",
      "true",
    );

    project.removeFile("drafts/outline.md");
    mkdirSync(join(project.root, "archive"), { recursive: true });
    project.addFile("archive/outline.md", "# Different identity\n");

    const oldTab = page.getByRole("tab", { name: /drafts\/outline\.md/ });
    await expect(oldTab).toHaveAttribute("aria-selected", "true");
    await expect(oldTab).toHaveAttribute("data-dirty", "true");
    await expect(visibleEditor(page)).toContainText("Unsaved on the original.");
    await expect(
      page.getByRole("button", { name: /Missing on disk: drafts\/outline\.md/ }),
    ).toBeVisible();
    await expect(rail.getByRole("treeitem", { name: "drafts/outline.md" })).toHaveCount(0);
    const replacementFolder = rail.getByRole("treeitem", { name: "archive", exact: true });
    await expect(replacementFolder).toBeVisible();
    await expect(replacementFolder).not.toHaveAttribute("aria-current");
    await replacementFolder.click();
    const replacement = rail.getByRole("treeitem", { name: "archive/outline.md" });
    await expect(replacement).toBeVisible();
    await expect(replacement).not.toHaveAttribute("aria-current");
    await expect(page.getByRole("tab", { name: /archive\/outline\.md/ })).toHaveCount(0);
  });

  test("project rail is one tab stop and arrow navigation activates the real open path", async ({
    page,
  }) => {
    project = createFixtureProject("# Existing notes\n");
    mkdirSync(join(project.root, "drafts"), { recursive: true });
    project.addFile("drafts/first.md", "# First draft\n");
    project.addFile("drafts/second.md", "# Second draft\n");
    await page.goto("/");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    const rail = page.getByRole("complementary", { name: "Project files" });
    const tree = rail.getByRole("tree");
    await expect(tree.getByRole("treeitem", { name: "drafts", exact: true })).toBeVisible();
    await expect(tree.locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);

    const hideRail = rail.getByRole("button", { name: "Hide project files" });
    const precedingControl = (await hideRail.count()) === 1
      ? hideRail
      : rail.getByRole("button", { name: "Refresh project files" });
    await precedingControl.focus();
    await page.keyboard.press("Tab");
    const drafts = tree.getByRole("treeitem", { name: "drafts", exact: true });
    await expect(drafts).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(drafts).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowRight");

    const first = tree.getByRole("treeitem", { name: "drafts/first.md" });
    const second = tree.getByRole("treeitem", { name: "drafts/second.md" });
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(second).toBeFocused();
    await page.keyboard.press("Enter");

    await expect(page.getByRole("tab", { name: /drafts\/second\.md/ })).toBeVisible();
    await expect(page.locator(".cm-content:visible")).toContainText("Second draft");
    await expect(second).toHaveAttribute("aria-current", "page");
    await page.keyboard.press("Tab");
    await expect(tree.locator(":focus")).toHaveCount(0);
  });

  test("a project-rail activation raced by file disappearance preserves workshop and reports the failed open", async ({
    page,
  }) => {
    project = createFixtureProject("# Disappearing notes\n");
    let releaseOpen;
    const openReleased = new Promise((resolve) => {
      releaseOpen = resolve;
    });
    // Hold only D23's HTTP transport after the production click has issued `open_document`: the
    // real Rust command still handles the released request, but the native refresh cannot remove
    // the clickable row before the activation we are trying to exercise (test-plan §7b).
    await page.route("**/open_document", async (route) => {
      await openReleased;
      await route.continue();
    });
    await page.goto("/");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    const rail = page.getByRole("complementary", { name: "Project files" });
    const file = rail.getByRole("treeitem", { name: "notes.md" });
    await expect(file).toBeVisible();
    const openReached = page.waitForRequest("**/open_document");
    await file.click();
    const request = await openReached;
    expect(request.postDataJSON()).toEqual({ root: project.root, path: project.path });

    const failedOpen = page.waitForResponse("**/open_document");
    project.removeFile();
    releaseOpen();
    const response = await failedOpen;
    expect(response.status()).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ kind: "Io" });

    await expect(page.locator(".shell-status")).toContainText(
      "Emend couldn’t complete the document action",
    );
    await expect(page.locator(".app-body")).toHaveClass(/app-body--workshop/);
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect(rail.locator('[role="treeitem"][aria-current="page"]')).toHaveCount(0);

    const composer = messageInput(page);
    await composer.fill("The composer stays available beside a status banner.");
    await expect(composer).toHaveValue("The composer stays available beside a status banner.");
  });

  test("a deliberately opened document under backend-hidden tooling stays present and keeps autosaving", async ({
    page,
  }) => {
    project = createFixtureProject("# Ordinary notes\n");
    const hiddenPath = "node_modules/pkg/README.md";
    mkdirSync(join(project.root, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(project.root, hiddenPath), "# Tool documentation\n");
    await page.goto("/");
    await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(50));
    await page.evaluate(
      ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
      { root: project.root, path: hiddenPath },
    );

    await expect(page.getByRole("tab", { name: /node_modules\/pkg\/README\.md/ })).toBeVisible();
    const rail = page.getByRole("complementary", { name: "Project files" });
    await rail.getByRole("button", { name: "Refresh project files" }).click();

    await expect(page.getByRole("button", { name: /Missing on disk/ })).toHaveCount(0);
    await page.locator(".cm-content:visible").click();
    await page.keyboard.type("Still here. ");
    await expect.poll(() => project.readSaved(hiddenPath)).toContain("Still here.");
  });

  test("a document deleted underneath the editor keeps its buffer, loses its rail row, and pauses autosave (J2 Missing on disk)", async ({
    page,
  }) => {
    // The whole lifecycle on real disk: a real deletion, the backend's own native watch, the
    // completed generation it produces, and what the shell does with it. Nothing here is mocked —
    // the only injected value is the autosave interval, so "no write happened" is a claim about a
    // debounce that has long since elapsed rather than about a race (test-plan §7).
    project = createFixtureProject("# Disappearing notes\n");
    project.addFile("second.md", "# Second document\n");
    await page.goto("/");
    await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(50));
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    const rail = page.getByRole("complementary", { name: "Project files" });
    const row = rail.getByRole("treeitem", { name: "notes.md" });
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.getByRole("tab", { name: /notes\.md/ })).toBeVisible();
    await expect(row).toHaveAttribute("aria-current", "page");
    await page.locator(".cm-content:visible").click();
    await page.keyboard.type("edited before the file vanished. ");
    await expect(page.locator(".cm-content:visible")).toContainText(
      "edited before the file vanished.",
    );
    // Let that edit save normally, so what is on disk is known before the file is removed.
    await expect
      .poll(() => project.readSaved())
      .toContain("edited before the file vanished.");
    const lastSavedBytes = project.readSaved();

    project.removeFile();
    // This case deliberately asks for a completed generation so the Missing lifecycle starts at a
    // known point. The automatic D23 announcement path is covered by the no-click liveness case
    // above; `ProjectRail` funnels both sources through the same deduped application path.
    await rail.getByRole("button", { name: "Refresh project files" }).click();

    // The banner, the persistent tab status, and the row's disappearance — all from one completed
    // generation proving the path is gone.
    await expect(
      page.getByText("This file is missing from its project path. Your open copy is safe."),
    ).toBeVisible();
    await expect(page.getByText("Autosave paused — file missing")).toBeVisible();
    await expect(rail.getByRole("treeitem", { name: "notes.md" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Missing on disk: notes\.md/ })).toBeVisible();
    // macOS has no qualifying confinement adapter by design (TD-18), so Recreate is absent there.
    if (process.platform === "darwin") {
      await expect(page.getByRole("button", { name: "Recreate" })).toHaveCount(0);
    } else {
      await expect(page.getByRole("button", { name: "Recreate" })).toBeVisible();
    }

    // Editing stays safe in memory, and nothing recreates the absent path behind the user's back.
    await page.locator(".cm-content:visible").click();
    await page.keyboard.type("still editable while missing. ");
    await expect(page.locator(".cm-content:visible")).toContainText("still editable while missing.");
    await page.waitForTimeout(300);
    expect(existsSync(join(project.root, "notes.md"))).toBe(false);

    // [Keep editing] dismisses the banner; the tab status is what persists, and reopens it.
    await page.getByRole("button", { name: "Keep editing" }).click();
    await expect(
      page.getByText("This file is missing from its project path. Your open copy is safe."),
    ).toHaveCount(0);
    await page.getByRole("button", { name: /Missing on disk: notes\.md/ }).click();
    await expect(
      page.getByText("This file is missing from its project path. Your open copy is safe."),
    ).toBeVisible();

    // [Close…] asks before discarding the only copy of that work; Cancel keeps it.
    await page.getByRole("button", { name: "Close…" }).click();
    const guard = page.getByRole("alertdialog");
    await expect(guard).toContainText("Close and discard Emend’s open copy?");
    await guard.getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator(".cm-content:visible")).toContainText("still editable while missing.");

    // The file reappears with exactly the bytes Emend last wrote: identical content, so the row
    // comes back, the Missing state ends, and autosave resumes at the original path — with no
    // changed-contents banner, because nothing about the file actually differs.
    project.addFile("notes.md", lastSavedBytes);
    await rail.getByRole("button", { name: "Refresh project files" }).click();
    await expect(rail.getByRole("treeitem", { name: "notes.md" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Missing on disk/ })).toHaveCount(0);
    await expect(page.getByText("This file changed outside the editor")).toHaveCount(0);
    await page.locator(".cm-content:visible").click();
    await page.keyboard.type("saved again. ");
    await expect.poll(() => project.readSaved()).toContain("saved again.");
  });

  test("a path that reappears under a concurrent creator's bytes keeps both sides, and says so (#1595)", async ({
    page,
  }) => {
    // The other half of the clause above: "differing content transitions to the ordinary
    // changed-contents banner ... preserving both sides" (ux-design, J2). The two injected clocks
    // fix the ordering this measures instead of waiting for it — an autosave armed while the file
    // was gone is still pending when the path comes back (2s debounce against a transition that
    // takes tens of ms), and nothing but the transition itself can read the file (a 60s poll), so
    // whether the disk side survives is decided here and only here.
    const buffer = "Emend's retained buffer";
    const external = "A concurrent creator's bytes";
    const { rail, editor } = await openMissingDocument(page, buffer, {
      autosaveMs: 2_000,
      pollMs: 60_000,
    });

    project.addFile(project.path, external);
    await rail.getByRole("button", { name: "Refresh project files" }).click();
    await expect(page.getByRole("button", { name: /Missing on disk/ })).toHaveCount(0);

    // Reaching this banner is two claims at once. It exists only because the transition read the
    // path, which is the divergence handling that has to be installed before writes resume; and it
    // could only find a divergence because nothing overwrote the file first — a write landing before
    // that read would have moved Emend's own baseline onto the disk, leaving nothing to report and
    // no way back to the bytes it replaced.
    await expect(page.getByText("This file changed outside the editor")).toBeVisible();
    expect(project.readSaved()).toBe(external);
    await expect(editor).toHaveText(buffer);
  });

  test("Reload's recovery status follows the real pending, failed, and saved phases while retry lands captured bytes (#1640, #2109)", async ({
    page,
  }) => {
    // #1599's vitest coverage proves Reload "replaces the buffer from the captured external side and
    // immediately submits those bytes through the atomic save runner, staying dirty until that write
    // succeeds" against a mocked saveDocument. This is the same guarantee through the assembled app
    // and the real save_document backend — the composition the vitest cases cannot see, mirroring the
    // #1595 e2e case above for the sibling write-pause guarantee.
    project = createFixtureProject("Original disk bytes");
    // This cell reads the saved readout out of the status bar, which is the Windows variant.
    await reportPlatform(page, "Win32");
    await page.goto("/");
    await page.evaluate(() => {
      // Autosave stays well clear of the whole scenario. The poll interval is generous (not raced)
      // — the point below is to hold it off deterministically once the divergence it needs to find
      // has been found, not to outrun it.
      window.__EMEND_E2E__?.setAutosaveIntervalMs(5_000);
      window.__EMEND_E2E__?.setExternalChangePollMs(1_000);
    });
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    const rail = page.getByRole("complementary", { name: "Project files" });
    const row = rail.getByRole("treeitem", { name: "notes.md" });
    await row.click();
    await expect(page.getByRole("tab", { name: /notes\.md/ })).toBeVisible();
    await expect(row).toHaveAttribute("aria-current", "page");
    const editor = visibleEditor(page);
    await expect(editor).toContainText("Original disk bytes");

    // A local edit diverges from disk. FR-ED-7's write-pause (#1599) keeps it from autosaving over
    // an unresolved external change, so nothing but the recovery write below can move the disk side.
    await editor.click();
    await page.keyboard.press("Control+a");
    const unsavedBuffer = "Emend's unsaved local edit";
    await page.keyboard.type(unsavedBuffer);
    await expect(editor).toHaveText(unsavedBuffer);

    const captured = "A concurrent editor's bytes";
    project.overwrite(captured);
    await expect(page.getByText("This file changed outside the editor")).toBeVisible();
    // Nothing autosaved the divergence away before the recovery write below.
    expect(project.readSaved()).toBe(captured);

    // Hold every further FR-ED-7 poll read (D23's HTTP transport only — the real Rust command
    // still runs on release, test-plan §7b) from this point on, never releasing them. The banner's
    // captured side is now pinned to `captured` for the rest of the test: no later poll can observe
    // the second external write below and re-capture it instead.
    await page.route("**/open_document", async () => {});

    // A second external write lands after capture, superseding `captured` on disk. With every poll
    // read held, nothing but the recovery write itself can read or touch the path again — so a final
    // disk read of `captured` (not this) can only be explained by that write actually landing.
    const supersededOnDisk = "A later external write nobody has read yet";
    project.overwrite(supersededOnDisk);

    // Hold only D23's HTTP transport after the production click has issued `save_document`: the
    // real Rust command still handles the released request once it continues, so the recovery write
    // itself — not a mock — is what has to land the bytes (test-plan §7b).
    let releaseSave;
    const saveReleased = new Promise((resolve) => {
      releaseSave = resolve;
    });
    await page.route("**/save_document", async (route) => {
      await saveReleased;
      await route.abort("failed");
    });
    const saveIssued = page.waitForRequest("**/save_document");

    const tab = page.getByRole("tab", { name: /notes\.md/ });
    const documentStatus = page.getByRole("region", { name: "Document status" });
    await expect(documentStatus.getByText("Not saved — writes paused")).toBeVisible();
    await expect(documentStatus.getByText(/^Saved · /)).toHaveCount(0);

    await page.getByRole("button", { name: "Reload" }).click();

    // The buffer is replaced with the captured side synchronously with the click. The banner's own
    // busy `reloading` presentation (#2074 AC4) has already yielded to its bannerless `reload-
    // write-pending` one (AC5, 11c.4) by the time these assertions run — but that absence is not
    // itself evidence the recovery write is done. FR-ED-7 keeps the document honestly dirty through
    // both phases, clearing only once the held write below actually succeeds (asserted at the end of
    // this test) — the still-dirty tab and explicit recovery readout prove the episode remains open.
    await expect(editor).toHaveText(captured);
    await expect(page.getByText("This file changed outside the editor")).toHaveCount(0);
    await expect(tab).toHaveAttribute("data-dirty", "true");
    await expect(
      documentStatus.getByText("Reloaded from disk · not saved yet"),
    ).toBeVisible();

    const request = await saveIssued;
    expect(request.postDataJSON()).toMatchObject({
      root: project.root,
      path: project.path,
      content: captured,
    });

    // Still dirty while the real write is held in flight, and the superseded write is still what is
    // actually on disk — the recovery write below, not a coincidence, is what the final read proves.
    await expect(tab).toHaveAttribute("data-dirty", "true");
    expect(project.readSaved()).toBe(supersededOnDisk);

    releaseSave();
    await expect(
      page.getByText("The version from disk is here, but it isn’t saved"),
    ).toBeVisible();
    await expect(documentStatus.getByText("Reloaded from disk · not saved yet")).toHaveCSS(
      "color",
      "rgb(163, 58, 46)",
    );

    await page.unroute("**/save_document");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => project.readSaved()).toBe(captured);
    await expect(tab).toHaveAttribute("data-dirty", "false");
    await expect(documentStatus.getByText(/^Saved · /)).toBeVisible();
  });

  test("Windows Recreate creates the missing document from the live buffer and resumes its row, active marker, and autosave", async ({
    page,
  }) => {
    test.skip(process.platform !== "win32", "TD-18 confinement is available only on Windows");
    const buffer = "Recovered through Recreate";
    const { rail, editor } = await openMissingDocument(page, buffer);

    await page.getByRole("button", { name: "Recreate" }).click();

    await expect
      .poll(() =>
        existsSync(join(project.root, project.path)) ? project.readSaved(project.path) : null,
      )
      .toBe(buffer);
    const restoredRow = rail.getByRole("treeitem", { name: "notes.md" });
    await expect(restoredRow).toBeVisible();
    await expect(restoredRow).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: /Missing on disk/ })).toHaveCount(0);

    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" and autosaved");
    await expect.poll(() => project.readSaved()).toBe(`${buffer} and autosaved`);
  });

  test("Windows Recreate reports Reappeared without reading or overwriting either the disk bytes or live buffer", async ({
    page,
  }) => {
    test.skip(process.platform !== "win32", "TD-18 confinement is available only on Windows");
    const buffer = "Emend's retained buffer";
    const external = "A concurrent creator's bytes";
    const { editor } = await openMissingDocument(page, buffer);

    // Hold only D23's HTTP transport after the production click has issued Recreate. The native
    // project observer is otherwise free to notice a file created before the click and correctly
    // remove the capability-bearing action from the DOM. Creating it in this route seam instead
    // gives the real Rust command the intended ordering deterministically: action offered and
    // invoked first, target appears second, atomic publication reports Reappeared third.
    await page.route("**/recreate_missing_document", async (route) => {
      project.addFile(project.path, external);
      await route.continue();
    });
    await page.getByRole("button", { name: "Recreate" }).click();

    await expect
      .poll(() =>
        existsSync(join(project.root, project.path)) ? project.readSaved(project.path) : null,
      )
      .toBe(external);
    await expect(editor).toHaveText(buffer);
    await expect(page.getByRole("button", { name: /Missing on disk/ })).toHaveCount(0);
    await expect(page.getByText("This file changed outside the editor")).toBeVisible();
    expect(project.readSaved()).toBe(external);
    await expect(editor).toHaveText(buffer);
  });

  test("Missing Save As carries history, tab, active row, and autosave; cancel, out-of-project, and failed write change nothing", async ({
    page,
  }) => {
    const historyBody = "This history must follow the recovered document.";
    project = createFixtureProject("Original disk bytes");
    await createComment(project.root, project.path, "reviewer", historyBody, null, 1_000);
    // `openMissingDocument` owns fixture creation, so reproduce its assembled transition here for
    // this fixture whose history was created before the move.
    await page.goto("/");
    await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(50));
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);
    const rail = page.getByRole("complementary", { name: "Project files" });
    const originalRow = rail.getByRole("treeitem", { name: "notes.md" });
    await originalRow.click();
    await expect(page.getByRole("tab", { name: /notes\.md/ })).toBeVisible();
    await expect(originalRow).toHaveAttribute("aria-current", "page");
    const editor = page.locator(".cm-content:visible");
    project.removeFile();
    await rail.getByRole("button", { name: "Refresh project files" }).click();
    await expect(page.getByRole("button", { name: /Missing on disk: notes\.md/ })).toBeVisible();
    await editor.click();
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.type("Save As buffer");
    await expect(editor).toHaveText("Save As buffer");

    const saveAs = page.getByRole("button", { name: "Save As…" });

    // Native-panel cancellation: no backend write, no identity transition, same recoverable tab.
    await chooseNextSaveAsDestination(page, null);
    await saveAs.click();
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" after cancel");
    await expect(editor).toHaveText("Save As buffer after cancel");
    await expect(page.getByRole("tab", { name: /notes\.md/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Missing on disk: notes\.md/ })).toBeVisible();
    expect(existsSync(join(project.root, project.path))).toBe(false);

    // A chosen path outside the project is refused before the backend and leaves the same state.
    const outside = join(project.root, "..", "emend-1516-outside.md");
    await chooseNextSaveAsDestination(page, outside);
    await saveAs.click();
    await expect(page.locator(".shell-status")).toContainText("outside the open project");
    await expect(page.getByRole("button", { name: /Missing on disk: notes\.md/ })).toBeVisible();
    expect(existsSync(outside)).toBe(false);

    // An in-project destination that is a directory makes the real atomic write fail. TD-18 rolls
    // its tentative history move back, so the old Missing identity and both byte locations stand.
    const blocked = join(project.root, "blocked.md");
    mkdirSync(blocked);
    await chooseNextSaveAsDestination(page, blocked);
    await saveAs.click();
    await expect(page.locator(".shell-status")).toContainText(
      "Emend couldn’t complete the document action.",
    );
    await expect(page.getByRole("tab", { name: /notes\.md/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Missing on disk: notes\.md/ })).toBeVisible();
    await expect(editor).toHaveText("Save As buffer after cancel");

    // A successful choice runs the same backend edge, carrying TD-4 history and the live buffer.
    const destination = "rescued.md";
    await chooseNextSaveAsDestination(page, join(project.root, destination));
    await saveAs.click();
    await expect
      .poll(() =>
        existsSync(join(project.root, destination)) ? project.readSaved(destination) : null,
      )
      .toBe("Save As buffer after cancel");
    await expect(page.getByRole("tab", { name: /rescued\.md/ })).toBeVisible();
    const rescuedRow = rail.getByRole("treeitem", { name: "rescued.md" });
    await expect(rescuedRow).toBeVisible();
    await expect(rescuedRow).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: /Missing on disk/ })).toHaveCount(0);
    await expect(editor).toHaveText("Save As buffer after cancel");
    const carriedThreads = await loadCommentThreads(project.root, destination);
    expect(carriedThreads.map((thread) => thread.body)).toContain(historyBody);

    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" and autosaved");
    await expect.poll(() => project.readSaved(destination)).toBe(
      "Save As buffer after cancel and autosaved",
    );
    expect(existsSync(join(project.root, project.path))).toBe(false);
  });

  test("brainstorm in workshop mode -> the agent's create_document births a draft as a tab — chat moves to the rail and the same thread continues; a second variant births a second tab (FR-CHAT-1/2)", async ({
    page,
  }) => {
    project = createFixtureProject("# Existing notes\n");
    await page.goto("/");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    // Workshop mode (J2 Phase A): the conversation is centre-stage, no document tab is open yet.
    await expect(page.getByRole("region", { name: "Timeline" })).toBeVisible();
    await expect(page.getByRole("main", { name: "Editor" })).toHaveCount(0);
    await expect(page.locator(".app-body")).toHaveClass(/app-body--workshop/);

    // A real brainstorm message, sent before any document exists (FR-CHAT-1).
    await messageInput(page).fill("thinking about a sermonette on Philippians 2");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("thinking about a sermonette on Philippians 2")).toBeVisible();

    const draftContent = "# Kenosis\n\nA daily reflection on Philippians 2.\n";
    await createDocument(project.root, "drafts/kenosis-daily.md", draftContent);

    // J2 Phase B: the created path opens as a tab, the birth card lands in the timeline, and the
    // layout leaves workshop mode for the standard authoring one — no save dialog, no prompt.
    await expect(page.getByRole("tab", { name: /drafts\/kenosis-daily\.md/ })).toBeVisible();
    await expect(page.locator(".cm-content")).toContainText("Kenosis");
    await expect(page.locator(".app-body")).not.toHaveClass(/app-body--workshop/);
    await expect(page.getByText("⬒ Draft created · Agent")).toBeVisible();
    await expect(page.getByText(`${draftContent.length.toLocaleString()} bytes`)).toBeVisible();

    // Same thread, not a new conversation (D4/J2): the pre-birth brainstorm message is still there.
    await expect(page.getByText("thinking about a sermonette on Philippians 2")).toBeVisible();

    // J2 edge state: asking for a second variant produces a second birth card and a second tab.
    await messageInput(page).fill("give me another variant, more casual tone");
    await page.getByRole("button", { name: "Send" }).click();
    const secondContent = "# Kenosis (casual)\n\nSame reflection, lighter tone.\n";
    await createDocument(project.root, "drafts/kenosis-daily-2.md", secondContent);

    await expect(page.getByRole("tab", { name: /drafts\/kenosis-daily\.md/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /drafts\/kenosis-daily-2\.md/ })).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(page.locator('[data-card-kind="document-birth"]')).toHaveCount(2);
  });

  test(
    "a UI-submitted chat message rehydrates after reload through startup project hydration and transcript IPC (#1395/#1749)",
    async ({ page }) => {
      project = createFixtureProject("# Transcript persistence\n");
      await page.goto("/");
      await page.evaluate(
        ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
        { root: project.root, path: project.path },
      );
      await expect(page.locator(".cm-content")).toBeVisible();

      const message = "This message must survive a full browser reload.";
      await messageInput(page).fill(message);
      await page.getByRole("button", { name: "Send" }).click();
      await expect(
        page.locator('[data-card-kind="chat-message"]', { hasText: message }),
      ).toHaveCount(1);

      await page.reload();
      await expect(page.locator(".cm-content")).toBeVisible();
      await expect(
        page.locator('[data-card-kind="chat-message"]', { hasText: message }),
        "persisted transcript card must rehydrate after reload",
      ).toHaveCount(1);
    },
  );

  test('"draft it" with a document already open still creates a new file and a second tab — never overwriting the open one (J2 edge state)', async ({
    page,
  }) => {
    const original = "# Existing outline\n\nOriginal content.\n";
    project = createFixtureProject(original);
    await page.goto("/");
    await page.evaluate(
      ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
      { root: project.root, path: project.path },
    );
    await expect(page.locator(".cm-content")).toContainText("Existing outline");
    await expect(page.locator(".app-body")).not.toHaveClass(/app-body--workshop/);

    await messageInput(page).fill("draft it");
    await page.getByRole("button", { name: "Send" }).click();

    await createDocument(
      project.root,
      "drafts/variant-2.md",
      "# Variant two\n\nA fresh draft.\n",
    );

    // The birth opens its own new tab alongside the one already open — never a replacement
    // (P2a-6's existing tab machinery, mirrored by `App.handleDocumentBirth`'s own docs).
    await expect(page.getByRole("tab", { name: /notes\.md/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /drafts\/variant-2\.md/ })).toBeVisible();
    await expect(page.getByRole("tab")).toHaveCount(2);

    // The already-open document's own file is untouched on disk — a genuinely new file, not an
    // overwrite of the one the user still has open.
    expect(project.readSaved()).toBe(original);
  });

  test("reviewer mode structurally excludes the project rail and Missing-on-disk recovery on Windows (#1515)", async ({
    page,
  }) => {
    await assertReviewerModeBoundary(page, "Win32");
  });

  test("reviewer mode structurally excludes the project rail and Missing-on-disk recovery on macOS (#1515)", async ({
    page,
  }) => {
    await assertReviewerModeBoundary(page, "MacIntel");
  });

  async function assertReviewerModeBoundary(page, navigatorPlatform) {
    project = createFixtureProject("# Reviewer boundary\n");
    await reportPlatform(page, navigatorPlatform);
    await page.goto("/");
    await page.evaluate((root) => window.__EMEND_E2E__?.openProjectFolder(root), project.root);

    const rail = page.getByRole("complementary", { name: "Project files" });
    await rail.getByRole("treeitem", { name: "notes.md" }).click();
    await expect(page.getByRole("tab", { name: /notes\.md/ })).toBeVisible();
    project.removeFile();
    await rail.getByRole("button", { name: "Refresh project files" }).click();

    // Prove the author-only surfaces are genuinely mounted before testing the mode boundary.
    await expect(page.getByRole("button", { name: /Missing on disk: notes\.md/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Keep editing" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save As…" })).toBeVisible();
    await page.getByRole("button", { name: "Close…" }).click();
    await expect(page.getByRole("alertdialog")).toContainText(
      "Close and discard Emend’s open copy?",
    );

    await page.evaluate(() => window.__EMEND_E2E__?.showReviewerWorkspace());

    await expect(page.locator('[data-workspace-mode="reviewer"]')).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Project files" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /project files/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Missing on disk/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Keep editing" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Recreate" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save As…" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Close…" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Close without saving" })).toHaveCount(0);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
  }
});

test.describe("P2b-11a J1 — revision-review complete: activity polling, delivery-while-typing, TD-7 partial apply (#365/#1826)", () => {
  // D23 transports the backend's real RunQueue state through `/run_state`; delivery reaches the UI
  // through its production observer, the driver event log, and the shared frontend event pump.
  /** @type {ReturnType<typeof createFixtureProject>} */
  let project;

  test.afterEach(async ({ page }) => {
    await project.cleanup(page);
  });

  async function openDoc(page) {
    await page.goto("/");
    await page.evaluate(() => window.__EMEND_E2E__?.setAutosaveIntervalMs(3_600_000));
    await page.evaluate(
      ({ root, path }) => window.__EMEND_E2E__?.openProject(root, path),
      { root: project.root, path: project.path },
    );
    await expect(page.locator(".cm-content")).toBeVisible();
  }

  function workingCard(page) {
    return page.locator('[data-card-kind="agent-working"]');
  }

  async function loadTranscript(root) {
    return /** @type {Promise<Array<Record<string, unknown>>>} */ (
      post("load_transcript", { root })
    );
  }

  async function assertRevisionCardAppearance(page, platform, expected) {
    await reportPlatform(page, platform);
    const content = "# Revision card\n\nOriginal body.\n";
    project = createFixtureProject(content);
    await openDoc(page);
    await proposeChanges(project.root, project.path, content, [
      { range: { offset: content.indexOf("Original"), length: 0 }, replacement: "Improved " },
    ], "Clarified the opening.");
    const card = page.locator('[data-card-kind="change-set"]').last();
    await expect(card).toContainText("Clarified the opening.");
    await expect(card.locator(".change-set-card__badge")).toHaveText("REVISION");
    await expect(card.locator(".change-set-card__author")).toHaveText("Agent");
    await expect(card.locator(".change-set-card__timestamp")).toBeVisible();
    await expect(card.getByRole("button", { name: "Review 1-by-1" })).toBeEnabled();
    const appearance = await card.evaluate((element) => {
      const shell = getComputedStyle(element);
      const review = getComputedStyle(element.querySelector('.change-set-card__actions > button'));
      return {
        border: shell.borderTopColor,
        radius: shell.borderTopLeftRadius,
        shadow: shell.boxShadow,
        reviewBackground: review.backgroundColor,
        reviewForeground: review.color,
        sectionCountColor: getComputedStyle(element.querySelector('.change-set-card__section-count')).color,
      };
    });
    expect(appearance).toEqual({
      ...expected,
      reviewBackground: "rgb(79, 70, 229)",
      reviewForeground: "rgb(255, 255, 255)",
      sectionCountColor: "rgb(140, 135, 121)",
    });
  }

  test("C2 revision card win presents badge hierarchy and active triage", async ({ page }) => {
    await assertRevisionCardAppearance(page, "Win32", {
      border: "rgb(198, 191, 174)",
      radius: "8px",
      shadow: "rgba(31, 29, 26, 0.07) 0px 2px 8px 0px",
    });
  });

  test("C2 revision card mac presents badge hierarchy and active triage", async ({ page }) => {
    await assertRevisionCardAppearance(page, "MacIntel", {
      border: "rgb(227, 223, 214)",
      radius: "10px",
      shadow: "rgba(31, 29, 26, 0.1) 0px 3px 12px 0px, rgb(216, 210, 196) 0px 0px 0px 1px",
    });
  });

  test("a UI-submitted run is rendered from the production TimelinePanel /run_state subscription (#1826)", async ({
    page,
  }) => {
    project = createFixtureProject("# Polled activity\n");
    await openDoc(page);

    await messageInput(page).fill("Please revise the opening.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("Please revise the opening.")).toBeVisible();
    await expect(workingCard(page).last()).toContainText("Agent stopped unexpectedly");
    await expect(workingCard(page).last()).toContainText("#1149");
    expect(await page.evaluate(() => "notifyAgentActivity" in (window.__EMEND_E2E__ ?? {}))).toBe(false);
  });

  test("two UI-submitted runs completed between polls each render their own terminal card (#1826)", async ({
    page,
  }) => {
    project = createFixtureProject("# Polled terminal history\n");
    await openDoc(page);

    await messageInput(page).fill("First quick request.");
    await page.getByRole("button", { name: "Send" }).click();
    await messageInput(page).fill("Second quick request.");
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText("First quick request.")).toBeVisible();
    await expect(page.getByText("Second quick request.")).toBeVisible();
    await expect(workingCard(page)).toHaveCount(2);
    await expect(workingCard(page).nth(0)).toContainText("Agent stopped unexpectedly");
    await expect(workingCard(page).nth(1)).toContainText("Agent stopped unexpectedly");
  });

  test("long unbroken document-path tokens stay inside their timeline cards", async ({
    page,
  }) => {
    project = createFixtureProject("# Timeline containment\n");
    await openDoc(page);
    const token = `${"x".repeat(180)}-draft.md`;

    await createDocument(project.root, token, "# Overflow\n");
    const birthCard = page.locator('[data-card-kind="document-birth"]');
    await expect(birthCard).toBeVisible();
    const birthPath = birthCard.locator(".document-birth-card__path");
    await expect(birthPath).toHaveAttribute("title", token);
    expect(await birthCard.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    expect(await birthPath.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);

    await messageInput(page).fill("following card");
    await page.getByRole("button", { name: "Send" }).click();
    const followingCard = page.locator('[data-card-kind="chat-message"]').last();
    await expect(followingCard).toBeVisible();
    const [birthBox, followingBox] = await Promise.all([
      birthCard.boundingBox(),
      followingCard.boundingBox(),
    ]);
    expect(birthBox).not.toBeNull();
    expect(followingBox).not.toBeNull();
    expect(birthBox.y + birthBox.height).toBeLessThanOrEqual(followingBox.y);
  });

  test("a terminal run observed through /run_state rehydrates through D15 (#1725/#1826)", async ({
    page,
  }) => {
    project = createFixtureProject("# Durable run activity\n");
    await openDoc(page);

    await messageInput(page).fill("Persist this run outcome.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(workingCard(page).last()).toContainText("Agent stopped unexpectedly");

    let runIds = [];
    await expect
      .poll(async () => {
        const transcript = await loadTranscript(project.root);
        runIds = transcript
          .filter((event) => event.kind === "agent-working")
          .map((event) => event.runId);
        return runIds.length;
      })
      .toBe(1);
    const [runId] = runIds;

    await page.reload();
    await expect(page.locator(".cm-content")).toBeVisible();

    await expect(page.locator(`[data-card-id="${runId}"]`)).toContainText(
      "Agent stopped unexpectedly",
    );
  });

  test("a card taller than the row height the virtualizer assumed never paints over the card after it", async ({
    page,
  }) => {
    // #1119, in the layer the defect actually lives in: jsdom runs no layout, so only a real engine
    // can answer whether a card's painted box overlaps its neighbour's. Every card here renders far
    // past the 96px `TimelinePanel` assumes for an unmeasured row — a chat message that wraps to
    // many lines, a run card carrying several activity lines — which is exactly the stream shape
    // that reported the bug (grounding card, user chat, completed run, user chat, completed run).
    project = createFixtureProject("# Timeline row sizing\n");
    await openDoc(page);

    const long = "A deliberately long message that wraps to several lines in the timeline rail. ".repeat(6);
    for (const body of [long, "short one", long]) {
      await messageInput(page).fill(body);
      await page.getByRole("button", { name: "Send" }).click();
    }
    await expect(page.locator('[data-card-kind="chat-message"]')).toHaveCount(3);

    const geometry = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".timeline-card")].map((card) => {
        const rect = card.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      });
      const list = document.querySelector('[data-testid="virtual-list"]');
      const children = [...list.children].map((child) => child.getBoundingClientRect().height);
      return {
        count: boxes.length,
        tallest: Math.max(...boxes.map((box) => box.height)),
        // Negative gap = the upper card painting into the lower one, the reported defect.
        smallestGap: Math.min(...boxes.slice(1).map((box, i) => box.top - boxes[i].bottom)),
        scrollHeight: list.scrollHeight,
        measuredTotal: children.reduce((total, height) => total + height, 0),
      };
    });

    expect(geometry.count).toBeGreaterThan(3);
    // Non-vacuity: at least one card really does render past the assumed row height, so the gap
    // assertion below is answering the question this test exists to ask.
    expect(geometry.tallest).toBeGreaterThan(96);
    expect(geometry.smallestGap).toBeGreaterThanOrEqual(0);
    // What the list measures each row at has to be the whole space that row occupies, or every
    // spacer standing in for an unmounted row is short by the difference. A row box that let the
    // card's own vertical margins collapse out of it (a wrapper that is not a BFC) reads as exactly
    // this: a scrollable extent larger than the sum of the boxes the measurements came from.
    expect(Math.abs(geometry.scrollHeight - geometry.measuredTotal)).toBeLessThan(1);
  });

  test("a reader sitting at the tail is carried to each arriving card that renders taller than the height assumed for it", async ({
    page,
  }) => {
    // The tail-follow half of #1119 (review finding, PR #1318 round 1), in the only layer that can
    // see it: an arriving card has never been mounted, so the commit that appends it can only lay it
    // out at the *assumed* height, and its real height lands a commit later. A follow that fires
    // once, on the append, therefore pins the reader to a tail that is already stale and never
    // corrects — in Chromium three arrivals left the newest card 534px below the fold, further than
    // the viewport is tall, i.e. entirely invisible to a reader who never moved. Every row measures
    // 0 in jsdom, so vitest can only reach this through an explicit height mock.
    project = createFixtureProject("# Timeline tail follow\n");
    await openDoc(page);

    const long = "A deliberately long message that wraps to several lines in the timeline rail. ".repeat(6);
    for (const body of [long, long]) {
      await messageInput(page).fill(body);
      await page.getByRole("button", { name: "Send" }).click();
    }
    await expect(page.locator('[data-card-kind="chat-message"]')).toHaveCount(2);
    // Each setup submit now starts a real D23 run. Let the real queue reach its final active
    // terminal and let both terminals reach the production subscriber before choosing the tail:
    // otherwise a slower runner can append that card while the document-birth arrival below is
    // being measured, mixing two independent growth events. `/run_state` retains each completion,
    // so the empty queue plus both terminal cards is the stable boundary; accepting only the newest
    // would hide the skipped-terminal regression this setup exposed.
    await expect
      .poll(async () => {
        const state = await post("run_state", {});
        return state.queued.length === 0 && state.active?.phase.phase === "failed" && state.finished.length === 2;
      })
      .toBe(true);
    await expect(workingCard(page)).toHaveCount(2);
    await expect(workingCard(page).last()).toContainText("Agent stopped unexpectedly");

    // Park the reader *at the tail by their own hand*, so what follows tests tail-follow alone and
    // not `TimelinePanel`'s submit-scroll, which reaches `scrollTop` through a different seam. Move
    // away first: the setup submits may already have placed the DOM at its maximum, where another
    // downward wheel produces no scroll event and therefore cannot record a fresh standing choice.
    const list = page.getByTestId("virtual-list");
    await list.hover();
    await page.mouse.wheel(0, -500);
    await expect
      .poll(() =>
        list.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeGreaterThan(2);
    await page.mouse.wheel(0, 10_000);
    await expect
      .poll(() =>
        list.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThan(2);
    // Let React commit the real scroll event's standing tail choice before the first arrival.
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );

    const readGeometry = () =>
      page.evaluate(() => {
        const list = document.querySelector('[data-testid="virtual-list"]');
        const cards = [...document.querySelectorAll(".timeline-card")];
        const newest = cards[cards.length - 1].getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        return {
          overflow: list.scrollHeight - list.clientHeight,
          scrollShortOfTail: list.scrollHeight - list.clientHeight - list.scrollTop,
          // How far the newest card's top sits below the bottom edge of the rail: > 0 means the
          // reader cannot see the card that just arrived at all.
          newestTopBelowFold: newest.top - listRect.bottom,
        };
      });

    for (const id of ["birth-tail-a", "birth-tail-b", "birth-tail-c"]) {
      await createDocument(
        project.root,
        `${id}-${"a-very-long-document-path/".repeat(6)}draft.md`,
        "# Tail card\n",
      );
      await expect(page.locator('[data-card-kind="document-birth"]').last()).toBeVisible();
      // DOM visibility lands before ResizeObserver measurement. Observe each arrival's completed
      // measured-height follow before introducing the next one: that is the title's "each arriving
      // card" property, rather than accidentally batching three provisional frames into one race.
      await expect
        .poll(async () => {
          const current = await readGeometry();
          return current.newestTopBelowFold < 0 && current.scrollShortOfTail < 2
            ? "settled at tail"
            : JSON.stringify(current);
        }, { message: `${id} must settle at the measured tail` })
        .toBe("settled at tail");
    }

    const geometry = await readGeometry();

    // Non-vacuity: the stream really does overflow its rail, so "follow the tail" is a question with
    // a moving answer rather than a no-op on content that always fit.
    expect(geometry.overflow).toBeGreaterThan(200);
    expect(geometry.newestTopBelowFold).toBeLessThan(0);
    expect(geometry.scrollShortOfTail).toBeLessThan(2);
  });

  test("Phase A -> B -> C: the run outcome arrives by polling; a delivery lands mid-typing with scroll/focus/selection untouched; keyboard triage accepts it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 720 });
    // A document tall enough that the caret's own paragraph sits off the initial viewport — reaching
    // it (below) is a genuine scroll, not a no-op, so "scroll position ... untouched" is asserted
    // against a baseline that has actually moved away from the top.
    const filler = Array.from(
      { length: 60 },
      (_, i) => `Filler paragraph number ${i} to make the document tall enough to scroll.`,
    ).join("\n\n");
    const sentence = "Hello brave world, and cheerful clouds today.\n";
    const content = `# J1 delivery-while-typing\n\n${filler}\n\n${sentence}`;
    project = createFixtureProject(content);
    // Mid-sentence, between "brave" and " world" — where the caret lands below.
    const caretOffset = content.indexOf(sentence) + "Hello brave".length;
    const tailLength = content.length - caretOffset;

    await openDoc(page);

    // --- Phase A: request a revision -> the driver's real queue outcome reaches the run card. ---
    await messageInput(page).fill("Please add an opening note.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Please add an opening note.")).toBeVisible();
    await expect(workingCard(page).last()).toContainText("Agent stopped unexpectedly");

    // The caret goes mid-sentence, scrolling the sentence's own paragraph into view — a genuine,
    // user-driven scroll (Principle 2: "the user's own deliberate act may scroll").
    const editor = page.locator(".cm-content");
    await editor.click();
    await page.keyboard.press(`${mod}+End`);
    for (let i = 0; i < tailLength; i++) await page.keyboard.press("ArrowLeft");

    const scroller = page.locator(".cm-scroller");
    const scrollTopBeforeDelivery = await scroller.evaluate((el) => el.scrollTop);
    const toolbar = page.getByRole("group", { name: "Review changes" });
    await expect(toolbar).toHaveCount(0);

    // --- Phase B: the delivery lands — a real backend write, over the real rebase/attribution path,
    // anchored to exactly what's on disk right now (no staleness in this test; TD-7's partial-apply
    // case is its own test below). It inserts a note at the very top, well away from the caret. ---
    const notice = await proposeChanges(
      project.root,
      project.path,
      content,
      [{ range: { offset: 0, length: 0 }, replacement: "Agent note.\n\n" }],
      "Added an opening note.",
    );
    expect(notice).not.toBeNull();

    // The counter and a new card move — the insertion itself landed at the very top of the document,
    // off the still-scrolled-down viewport, so its own redline decoration is asserted in the TD-7
    // test below (a short, unscrolled document) rather than here: CM6 only ever renders the
    // viewport's own lines into the DOM, so a `.cm-redlineInsert` locator here would be asserting
    // against whatever the browser happens to have virtualized, not against the delivery itself.
    await expect(toolbar).toContainText("1 of 1");
    await expect(page.locator('[data-card-kind="change-set"]')).toContainText(
      "Added an opening note.",
    );

    // ...but the caret's own neighbourhood, focus, and scroll position do not (Principle 2). Typing
    // with no refocus proves both focus and the exact caret position survived the delivery's own
    // transaction — a lost caret or a stolen focus would land the "!" somewhere else entirely, or not
    // at all.
    await page.keyboard.type("!");
    await expect(editor).toContainText("Hello brave! world");
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(scrollTopBeforeDelivery);

    // --- Phase C: keyboard-only triage accepts the delivered change (the existing
    // NI-a11y-keyboard-triage journey's own chord, reused rather than replaced). ---
    await page.keyboard.press(`${mod}+Home`);
    await page.keyboard.press(`${mod}+Enter`);
    await expect(toolbar).toHaveCount(0);
    await expect(editor).toContainText("Agent note.");

    // The saved file — not the (now scrolled-to-the-top) DOM — is what proves the mid-document "!"
    // survived the whole round trip, since CM6 no longer renders that far-off line into the DOM here.
    await page.keyboard.press(`${mod}+s`);
    await expect.poll(() => project.readSaved()).toContain("Agent note.");
    await expect.poll(() => project.readSaved()).toContain("Hello brave! world");
  });

  test("TD-7 partial apply: an edit anchored to text the live document has since diverged under goes stale — the untouched-text edit still lands as one complete attributed set — honestly", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 720 });
    const base = "one two three four five\n";
    project = createFixtureProject(base);
    await openDoc(page);
    const toolbar = page.getByRole("group", { name: "Review changes" });
    await expect(toolbar).toHaveCount(0);

    // The user keeps typing while the agent works — a real write to the same file, landing after the
    // agent's own base was captured (mirrors `propose_changes_partitions_stale_edits_...`'s rust
    // precedent, this time exercised end to end).
    const live = "one two three four FIVE\n";
    project.overwrite(live);

    // Anchored to `base`: one edit at the untouched head, one at the tail the user has since changed.
    const notice = await proposeChanges(
      project.root,
      project.path,
      base,
      [
        { range: { offset: 0, length: 0 }, replacement: "zero " },
        { range: { offset: 19, length: 4 }, replacement: "5" },
      ],
      "renumber",
    );
    expect(notice).not.toBeNull();
    expect(notice.changes.length).toBe(1);
    expect(notice.stale).toBe(1);


    // Honestly partial: exactly the one surviving edit is pending — never a phantom second one for
    // the edit that went stale — and the user's own "FIVE" is untouched, not silently overwritten.
    // (`.cm-redlineInsert` targets the inserted span's own text, excluding the CriticMarkup
    // delimiters — those get their own separate, always-present-in-DOM `cm-markupHidden` mark, so a
    // raw `.cm-content` substring check would see "{++zero ++}" rather than the clean "zero ".)
    await expect(toolbar).toContainText("1 of 1");
    const editor = page.locator(".cm-content");
    await expect(editor).toContainText("FIVE");
    await expect(page.locator(".cm-redlineInsert")).toHaveText("zero ");

    await page.keyboard.press(`${mod}+s`);
    await expect.poll(() => project.readSaved()).toBe("{++zero ++}one two three four FIVE\n");
  });

  test("a failed run applies nothing and a later complete delivery is never partial markup (FR-AGENT-6/#1826)", async ({
    page,
  }) => {
    const content = "Hello world.\n";
    project = createFixtureProject(content);
    await openDoc(page);

    await messageInput(page).fill("Revise this document.");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(workingCard(page).last()).toContainText("Agent stopped unexpectedly");
    expect(project.readSaved()).toBe(content);

    // A complete delivery lands atomically, independent of the failed run above.
    const notice = await proposeChanges(
      project.root,
      project.path,
      content,
      [{ range: { offset: content.length, length: 0 }, replacement: "More to say." }],
      "Started a thought.",
    );
    expect(notice).not.toBeNull();
    expect(project.readSaved()).toBe(notice.content);

    // Still exactly the complete delivered set — no re-render touched it into something partial.
    expect(project.readSaved()).toBe(notice.content);
  });
});
test("J7 permission callbacks wait for run-card allow, denial guidance, and Stop (#2399)", async ({ page }) => {
  const project = createFixtureProject("# Protected permission draft\n");
  const driver = await permissionDriver(page);
  try {
    await page.goto("/");
    await openDocument(page, project);
    for (const mode of ["allow", "deny", "stop"]) {
      await messageInput(page).fill(`permission fixture ${mode}`);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const card = page.locator('[data-card-kind="agent-working"]').last();
      await expect(card.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
      await expect(card).toContainText("WANTS TO RUN:");
      await expect(card.getByText("Bash", { exact: true })).toBeVisible();
      await expect(card).toContainText("waiting");
      await expect(card).toContainText("python3 permission-witness.py");
      await expect(card).toContainText("why: “Permission acceptance witness”");
      if (mode === "allow") {
        const alwaysAllow = card.getByRole("button", { name: "Always allow", exact: true });
        await expect(alwaysAllow).toBeEnabled();
        await alwaysAllow.click();
        await expect(
          card.getByRole("menuitem", { name: "Always allow this exact command" }),
        ).toBeVisible();
        await expect(card.getByRole("menuitem", { name: "Always allow this script" })).toHaveCount(0);
        await alwaysAllow.click();
      }
      const before = await driver.post("permission_state");
      expect(before.requests).toHaveLength(1);
      expect((await driver.post("run_state")).active.id).toBe(before.runId);
      // Ignoring the card while composing neither decides nor steals the composer's focus.
      await messageInput(page).fill("I am still deciding");
      await expect(messageInput(page)).toBeFocused();
      expect((await driver.post("permission_state")).requests[0].id).toBe(before.requests[0].id);
      if (mode === "allow") await card.getByRole("button", { name: "Allow once", exact: true }).click();
      else if (mode === "deny") {
        await card.getByRole("button", { name: "Deny — tell it why…", exact: true }).click();
        await card
          .getByRole("textbox", { name: "Why are you denying this action?", exact: true })
          .fill("Use the existing draft instead.");
        await card.getByRole("button", { name: "Send denial", exact: true }).click();
      } else await card.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(card).toContainText(mode === "stop" ? "STOPPED" : "Completed");
      await expect(card.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
      expect((await driver.post("permission_state")).requests).toEqual([]);
      if (mode !== "stop") {
        const response = JSON.parse(readFileSync(join(project.root, `permission-${mode}.json`), "utf8"));
        expect(response).toEqual(
          mode === "allow"
            ? {
                behavior: "allow",
                updatedInput: {
                  command: "python3 permission-witness.py",
                  description: "Permission acceptance witness",
                },
              }
            : { behavior: "deny", message: "Use the existing draft instead." },
        );
      }
    }
    expect(project.readSaved()).toBe("# Protected permission draft\n");
  } finally {
    await driver.close();
    await project.cleanup(page);
  }
});

test("J7 keeps a real pending permission discoverable when Changes filters out its run card (#2429)", async ({ page }) => {
  const project = createFixtureProject("# Filtered permission draft\n");
  const replacementProject = createFixtureProject("# Replacement project\n");
  const driver = await permissionDriver(page);
  try {
    await page.goto("/");
    await openDocument(page, project);
    await messageInput(page).fill("permission fixture allow");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const card = page.locator('[data-card-kind="agent-working"]').last();
    await expect(card.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
    const pending = await driver.post("permission_state");
    expect(pending.requests).toHaveLength(1);

    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await messageInput(page).focus();
    const cue = page.getByRole("button", { name: "Show permission request in Timeline", exact: true });
    await expect(cue).toBeVisible();
    await expect(page.getByRole("button", { name: "Changes", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(messageInput(page)).toBeFocused();
    await expect(card).toHaveCount(0);
    expect((await driver.post("permission_state")).requests[0].id).toBe(pending.requests[0].id);

    await page.getByRole("button", { name: "Hide Timeline" }).click();
    await expect(page.getByRole("region", { name: "Comments" })).toBeVisible();
    await expect(cue.locator(".timeline-host__permission-badge")).toHaveCount(1);
    await cue.click();
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute("aria-pressed", "true");
    const heading = page.getByRole("heading", { name: "Permission request: Bash", exact: true });
    await expect(heading).toBeVisible();
    await expect(heading).toBeFocused();
    await card.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(cue).toHaveCount(0);
    await expect(card).toContainText("Completed");
    expect((await driver.post("permission_state")).requests).toEqual([]);

    await page.evaluate(
      // D23 directly constructs a replacement project here because TD-20 product routing must
      // leave an already-bound choosing window on its current project. This test is about J7's
      // focus restoration across a real shell replacement, not J9's separate-window route.
      (root) => window.__EMEND_E2E__?.openProject(root, null),
      replacementProject.root,
    );
    const boundRoot = await driver.post("current_project");
    expect(realpathSync(boundRoot.replace(/^\\\\\?\\/, ""))).toBe(
      realpathSync(replacementProject.root.replace(/^\\\\\?\\/, "")),
    );
    await expect(page.locator(".app-body")).toHaveClass(/app-body--workshop/);
    await expect(page.getByRole("tab", { name: project.path })).toHaveCount(0);
    await expect(page.locator(".cm-content:visible")).toHaveCount(0);
    await expect(page.locator(".timeline-host__label", { hasText: "TIMELINE" })).toBeFocused();
  } finally {
    const stillPending = await driver.post("permission_state").catch(() => ({ runId: null }));
    if (stillPending.runId) {
      await driver.post("stop_run", { runId: stillPending.runId }).catch(() => {});
      await expect.poll(async () => (await driver.post("run_state")).active).toBeNull().catch(() => {});
    }
    await driver.close();
    await replacementProject.cleanup(page);
    await project.cleanup(page);
  }
});

async function assertNarrowPendingPermission(page, reportedPlatform) {
  const project = createFixtureProject("# Narrow permission draft\n");
  const driver = await permissionDriver(page);
  try {
    await reportPlatform(page, reportedPlatform);
    await page.setViewportSize({ width: 1400, height: 700 });
    await page.goto("/");
    await openDocument(page, project);
    await messageInput(page).fill("permission fixture allow");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const card = page.locator('[data-card-kind="agent-working"]').last();
    await expect(card.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: "Hide Timeline" }).click();
    const editor = page.locator(".cm-content[role='textbox']:visible");
    await editor.focus();
    await page.setViewportSize({ width: 1000, height: 700 });

    const cue = page.getByRole("button", { name: "Show permission request in Timeline", exact: true });
    const toolbar = page.locator(".view-mode-toolbar:visible");
    await expect(toolbar.locator('[data-toolbar-control="timeline"]')).not.toHaveAttribute("data-overflowed", "true");
    await expect(toolbar.locator('[data-toolbar-control="format-group"]')).toHaveAttribute("data-overflowed", "true");
    const geometry = await toolbar.evaluate((row) => {
      const host = row.querySelector('[data-toolbar-control="timeline"]');
      const badge = host?.querySelector(".timeline-host__permission-badge");
      const editor = row.closest(".editor-region");
      const projectRail = document.querySelector(".project-rail");
      const comments = document.querySelector(".comments-column");
      const segmented = row.querySelector(".view-mode-toolbar__editor-view");
      const overflow = row.querySelector(".view-mode-toolbar__overflow-trigger");
      return {
        rowLeft: row.getBoundingClientRect().left,
        rowRight: row.getBoundingClientRect().right,
        rowWidth: row.getBoundingClientRect().width,
        editorWidth: editor?.getBoundingClientRect().width,
        projectWidth: projectRail?.getBoundingClientRect().width,
        commentsWidth: comments?.getBoundingClientRect().width,
        hostLeft: host?.getBoundingClientRect().left,
        hostRight: host?.getBoundingClientRect().right,
        hostWidth: host?.getBoundingClientRect().width,
        hostOverflowed: host?.getAttribute("data-overflowed"),
        segmentedWidth: segmented?.getBoundingClientRect().width,
        overflowWidth: overflow?.getBoundingClientRect().width,
        badgeWidth: badge?.getBoundingClientRect().width,
      };
    });
    expect(geometry.hostOverflowed, JSON.stringify(geometry)).not.toBe("true");
    await expect(cue).toBeVisible();
    expect(geometry.hostRight, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.rowRight);
    expect(geometry.badgeWidth).toBe(16);
    await expect(editor).toBeFocused();
    await expect(page.locator(".timeline-panel__facet", { hasText: "Changes" })).toHaveAttribute("aria-pressed", "true");

    await cue.focus();
    await cue.press("Enter");
    const heading = page.getByRole("heading", { name: "Permission request: Bash", exact: true });
    await expect(heading).toBeFocused();
    await page.getByRole("button", { name: "Hide Timeline" }).click();
    const stableCue = toolbar.locator('[data-toolbar-control="timeline"] .timeline-host__collapsed-action');
    await stableCue.focus();
    await page.evaluate(() => { window.__narrowTimelineChip = document.querySelector(".timeline-host__collapsed-action"); });
    const pending = await driver.post("permission_state");
    await driver.post("stop_run", { runId: pending.runId });
    await expect(stableCue.locator(".timeline-host__permission-badge")).toHaveCount(0);
    await expect(stableCue).toHaveAccessibleName("Show Timeline");
    await expect(stableCue).toBeFocused();
    expect(await page.evaluate(() => window.__narrowTimelineChip === document.querySelector(".timeline-host__collapsed-action"))).toBe(true);
  } finally {
    const pending = await driver.post("permission_state").catch(() => ({ runId: null }));
    if (pending.runId) {
      await driver.post("stop_run", { runId: pending.runId }).catch(() => {});
      await expect.poll(async () => (await driver.post("run_state")).active).toBeNull().catch(() => {});
    }
    await driver.close();
    await project.cleanup(page);
  }
}

test("#2540 narrow pending permission keeps the Timeline host visible on Windows", async ({ page }) => {
  await assertNarrowPendingPermission(page, "Win32");
});

test("#2540 narrow pending permission keeps the Timeline host visible on macOS", async ({ page }) => {
  await assertNarrowPendingPermission(page, "MacIntel");
});

async function assertCompactPendingPermission(page, reportedPlatform) {
  const project = createFixtureProject("# Compact permission draft\n");
  const driver = await permissionDriver(page);
  try {
    await reportPlatform(page, reportedPlatform);
    await page.setViewportSize({ width: 1400, height: 700 });
    await page.goto("/");
    await openDocument(page, project);
    await messageInput(page).fill("permission fixture allow");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Changes", exact: true }).click();
    await page.getByRole("button", { name: "Hide Timeline" }).click();
    const editor = page.locator(".cm-content[role='textbox']:visible");
    await editor.focus();
    await page.setViewportSize({ width: 900, height: 700 });

    const toolbar = page.locator(".view-mode-toolbar:visible");
    const slot = toolbar.locator('[data-toolbar-control="timeline"]');
    const cue = slot.locator(".timeline-host__collapsed-action");
    await expect(cue).toHaveAccessibleName("Show permission request in Timeline");
    await expect(slot).not.toHaveAttribute("data-overflowed", "true");
    await expect(cue).toBeVisible();
    await expect(cue.locator(".timeline-host__permission-badge")).toBeVisible();
    await expect(cue.locator(":scope > svg")).toBeVisible();
    await expect(toolbar.locator('[data-toolbar-control="format-group"]')).toHaveAttribute("data-overflowed", "true");
    await page.evaluate(() => document.fonts.ready);
    const geometry = await page.evaluate(() => {
      const projectRail = document.querySelector(".project-rail");
      const comments = document.querySelector(".comments-column");
      const row = document.querySelector(".view-mode-toolbar");
      const chip = row.querySelector(".timeline-host__collapsed-action");
      const mic = row.querySelector(".view-mode-toolbar__dictation .dictation-mic");
      const more = row.querySelector('button[aria-label="More editor controls"]');
      const text = chip.querySelector("span:first-child");
      return {
        project: projectRail.getBoundingClientRect().width,
        comments: comments.getBoundingClientRect().width,
        row: row.getBoundingClientRect().toJSON(),
        chip: chip.getBoundingClientRect().toJSON(),
        mic: mic.getBoundingClientRect().toJSON(),
        micInOverflow: Boolean(mic.closest(".view-mode-toolbar__overflow-popover")),
        more: more.getBoundingClientRect().toJSON(),
        textDisplay: getComputedStyle(text).display,
      };
    });
    expect(geometry.project).toBe(236);
    expect(geometry.comments).toBe(400);
    expect(geometry.row.width).toBe(263);
    expect(geometry.row.height).toBe(reportedPlatform === "Win32" ? 45 : 47);
    expect(geometry.chip.width).toBe(44);
    expect(geometry.chip.right).toBeLessThanOrEqual(geometry.row.right);
    expect(geometry.mic.width).toBe(28);
    expect(geometry.mic.height).toBe(26);
    expect(geometry.micInOverflow).toBe(false);
    expect(geometry.mic.left).toBeGreaterThanOrEqual(geometry.row.left);
    expect(geometry.mic.right).toBeLessThanOrEqual(geometry.row.right);
    expect(geometry.more.right).toBeLessThanOrEqual(geometry.row.right);
    expect(geometry.textDisplay).toBe("none");
    await expect(editor).toBeFocused();
    await expect(page.locator(".timeline-panel__facet", { hasText: "Changes" })).toHaveAttribute("aria-pressed", "true");

    await cue.focus();
    await cue.press("Enter");
    await expect(page.getByRole("heading", { name: "Permission request: Bash", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Hide Timeline" }).click();
    await expect(cue).toHaveAccessibleName("Show permission request in Timeline");
    const pending = await driver.post("permission_state");
    await cue.focus();
    await page.evaluate(() => { window.__compactTimelineChip = document.querySelector(".timeline-host__collapsed-action"); });
    await driver.post("stop_run", { runId: pending.runId });
    await expect(cue.locator(".timeline-host__permission-badge")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Show Timeline", exact: true })).toBeFocused();
    expect(await page.evaluate(() => window.__compactTimelineChip === document.querySelector(".timeline-host__collapsed-action"))).toBe(true);
    await expect(cue).toHaveAttribute("aria-label", "Show Timeline");
    await expect(cue.locator("svg")).toBeVisible();
    await expect(cue).toBeVisible();
    await expect(toolbar.locator(".view-mode-toolbar__dictation .dictation-mic")).toBeVisible();
    const more = toolbar.getByRole("button", { name: "More editor controls" });
    await expect(more).toBeVisible();
    await more.focus();
    await more.press("ArrowDown");
    await expect(page.getByRole("dialog", { name: "More editor controls" }).getByRole("button", { name: "Bold" })).toBeVisible();
    await expect(cue).toBeVisible();
  } finally {
    const pending = await driver.post("permission_state").catch(() => ({ runId: null }));
    if (pending.runId) {
      await driver.post("stop_run", { runId: pending.runId }).catch(() => {});
      await expect.poll(async () => (await driver.post("run_state")).active).toBeNull().catch(() => {});
    }
    await driver.close();
    await project.cleanup(page);
  }
}

test("#2540 compact 900px keeps the pending Timeline host visible on Windows", async ({ page }) => {
  await assertCompactPendingPermission(page, "Win32");
});

test("#2540 compact 900px keeps the pending Timeline host visible on macOS", async ({ page }) => {
  await assertCompactPendingPermission(page, "MacIntel");
});

async function assertCompactViewSwitch(page, reportedPlatform) {
  const project = createFixtureProject("# Compact view switch\n\nKeep these source bytes.\n");
  try {
    await reportPlatform(page, reportedPlatform);
    await page.setViewportSize({ width: 1400, height: 700 });
    await page.goto("/");
    await openDocument(page, project);
    await page.getByRole("button", { name: "Hide Timeline" }).click();
    await page.setViewportSize({ width: 900, height: 700 });
    await page.evaluate(() => document.fonts.ready);

    const toolbar = page.locator(".view-mode-toolbar:visible");
    const viewSlot = toolbar.locator('[data-toolbar-control="editor-view"]');
    const more = toolbar.getByRole("button", { name: "More editor controls" });
    await expect(viewSlot).toHaveAttribute("data-overflowed", "true");
    await expect(more).toBeVisible();
    const source = await page.locator(".cm-content:visible").textContent();

    await more.focus();
    await more.press("ArrowDown");
    const menu = page.getByRole("dialog", { name: "More editor controls" });
    await expect(menu.getByRole("button", { name: "Rich text" })).toHaveAttribute("aria-pressed", "true");
    await menu.getByRole("button", { name: "Markdown" }).focus();
    await menu.getByRole("button", { name: "Markdown" }).press("Enter");
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(more).toBeFocused();
    expect(await page.locator(".cm-content:visible").textContent()).toBe(source);

    await more.click();
    await expect(menu.getByRole("button", { name: "Markdown" })).toHaveAttribute("aria-pressed", "true");
    await menu.getByRole("button", { name: "Rich text" }).click();
    await expect(more).toHaveAttribute("aria-expanded", "false");
    await expect(more).toBeFocused();
    expect(await page.locator(".cm-content:visible").textContent()).toBe(source);

    await more.press("ArrowDown");
    await menu.getByRole("button", { name: "Markdown" }).focus();
    await page.setViewportSize({ width: 1200, height: 700 });
    await expect(viewSlot).not.toHaveAttribute("data-overflowed", "true");
    await expect(toolbar.getByRole("button", { name: "Markdown" })).toBeFocused();
    await expect(toolbar.getByRole("button", { name: "Rich text" })).toHaveAttribute("aria-pressed", "true");
  } finally {
    await project.cleanup(page);
  }
}

test("#2641 compact toolbar moves working view switch on Windows", async ({ page }) => {
  await assertCompactViewSwitch(page, "Win32");
});

test("#2641 compact toolbar moves working view switch on macOS", async ({ page }) => {
  await assertCompactViewSwitch(page, "MacIntel");
});

test("#2540 threshold arrival keeps the focused format action in place", async ({ page }) => {
  const content = "# Threshold permission draft\n";
  const project = createFixtureProject(content);
  await createComment(project.root, project.path, "reviewer", "permission fixture allow",
    { content, utf16Offset: content.indexOf("Threshold"), utf16Length: "Threshold".length }, 0);
  const driver = await permissionDriver(page);
  try {
    await reportPlatform(page, "Win32");
    await page.setViewportSize({ width: 1200, height: 700 });
    await page.goto("/");
    await openDocument(page, project);
    await page.getByRole("button", { name: "Hide Timeline" }).click();
    const toolbar = page.locator(".view-mode-toolbar:visible");
    const slot = toolbar.locator('[data-toolbar-control="format-group"]');
    const chip = toolbar.locator('[data-toolbar-control="timeline"] .timeline-host__collapsed-action');
    const target = await toolbar.evaluate((row) => {
      const style = getComputedStyle(row);
      const width = row.querySelector(".view-mode-toolbar__editor-view").getBoundingClientRect().width +
        row.querySelector('[data-toolbar-control="format-group"]').getBoundingClientRect().width +
        row.querySelector(".view-mode-toolbar__dictation").getBoundingClientRect().width +
        row.querySelector('[data-toolbar-control="timeline"]').getBoundingClientRect().width +
        3 * parseFloat(style.gap) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 8;
      return Math.round(window.innerWidth - row.getBoundingClientRect().width + width);
    });
    await page.setViewportSize({ width: target, height: 700 });
    await expect(slot).not.toHaveAttribute("data-overflowed", "true");
    await expect(chip).toHaveAccessibleName("Show Timeline");
    await expect(chip.locator(".timeline-host__permission-badge")).toHaveCount(0);
    const idleChipWidth = await chip.evaluate((button) => button.getBoundingClientRect().width);
    const bold = toolbar.getByRole("button", { name: "Bold" });
    await bold.focus();
    await page.evaluate(() => {
      window.__thresholdBold = document.querySelector('button[aria-label="Bold"]');
      window.__thresholdChip = document.querySelector('.timeline-host__collapsed-action');
    });

    await page.locator(".comments-column .comment-thread-card__address").evaluate((button) => button.click());
    await expect(chip).toHaveAccessibleName("Show permission request in Timeline");
    await expect(chip.locator(".timeline-host__permission-badge")).toBeVisible();
    expect(await chip.evaluate((button) => button.getBoundingClientRect().width)).toBe(idleChipWidth);
    await expect(slot).not.toHaveAttribute("data-overflowed", "true");
    await expect(bold).toBeFocused();
    expect(await page.evaluate(() => window.__thresholdBold === document.querySelector('button[aria-label="Bold"]'))).toBe(true);
    expect(await page.evaluate(() => window.__thresholdChip === document.querySelector('.timeline-host__collapsed-action'))).toBe(true);
    expect(await toolbar.evaluate((row) => row.getBoundingClientRect().height)).toBe(45);
  } finally {
    const run = await driver.post("run_state").catch(() => ({ active: null }));
    if (run.active?.id) await driver.post("stop_run", { runId: run.active.id }).catch(() => {});
    await expect.poll(async () => (await driver.post("run_state")).active).toBeNull().catch(() => {});
    await driver.close();
    await project.cleanup(page);
  }
});

test("J7 script approval reuses changed arguments through the real callback (#2399)", async ({ page }) => {
  const project = createFixtureProject("# Protected script draft\n");
  const driver = await permissionDriver(page);
  try {
    await page.goto("/");
    await openDocument(page, project);
    await messageInput(page).fill("permission fixture script");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    const card = page.locator('[data-card-kind="agent-working"]').last();
    await expect(card.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Always allow", exact: true }).click();
    await expect(card.getByRole("menuitem", { name: "Always allow this script", exact: true })).toBeVisible();
    const pending = await driver.post("permission_state");
    expect(pending.requests[0].allowScript).toBe(true);
    await card.getByRole("menuitem", { name: "Always allow this script", exact: true }).click();
    await expect(card).toContainText("Completed");
    expect((await driver.post("permission_state")).requests).toEqual([]);
    const responses = JSON.parse(readFileSync(join(project.root, "permission-script.json"), "utf8"));
    expect(responses).toEqual([1, 2].map((chapter) => ({
      behavior: "allow",
      updatedInput: {
        command: `python3 '${realpathSync(join(project.root, "permission-witness.py")).replaceAll("\\", "/")}' --chapter ${chapter}`,
        description: "Permission script witness",
      },
    })));
    expect(project.readSaved()).toBe("# Protected script draft\n");
  } finally {
    await driver.close();
    await project.cleanup(page);
  }
});
