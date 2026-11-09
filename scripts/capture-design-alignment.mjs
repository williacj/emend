// ABOUTME: Captures the integrated Emend frontend against the existing design-alignment baseline.
// ABOUTME: Uses the production Vite tree and D23 backend with disposable projects, then records pixels and CSS geometry.
import { chromium } from "@playwright/test";
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allocateLoopbackPorts } from "./e2e-ports.mjs";
import { assertProjectOpenCapture } from "./capture-design-alignment-state.mjs";

const repository = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(process.env.EMEND_ALIGNMENT_OUTPUT ?? join(repository, "docs/alignment-after"));
const fixtureParent = mkdtempSync(join(tmpdir(), "cowrite-alignment-after-"));
const platformNames = [
  { id: "win", navigatorPlatform: "Win32" },
  { id: "mac", navigatorPlatform: "MacIntel" },
];
const selectors = [
  ".app-header", ".welcome-screen", ".writing-partners", ".app-body",
  ".project-rail", ".project-rail__header", ".project-rail__tree", ".project-rail__status",
  ".project-rail__footer", ".editor-region", ".tab-bar", ".view-mode-toolbar",
  ".redline-toolbar", ".editor-shell__host", ".document-status-bar",
  ".timeline-panel", ".timeline-panel__header", ".timeline-panel__facets",
  ".timeline-panel__stream", ".timeline-card", ".change-set-card",
  ".change-set-card__section-count", ".change-set-card__actions",
  ".message-composer", ".quote-bar", ".comment-popover", ".comment-thread-card",
  '[data-card-kind="comment"]', ".comment-thread-card__menu", ".comment-thread-card__menu-reason",
  ".comment-thread-card__correction", ".comment-thread-card__delete-refusal",
  ".settings-dialog", ".voice-settings__heading-row", "#settings-voice-heading",
  ".voice-settings__heading-row button", ".voice-settings__switch-control", ".voice-settings__switch",
  ".voice-settings__switch-state", ".voice-settings__off-note",
  ".voice-settings__device-row .settings-dialog__setting-label",
  ".voice-settings__device-control select", ".voice-settings__device-issue",
  ".untitled-document", ".untitled-document__loss-notice",
  ".editor-shell__selection-affordances", ".cm-commentHighlight", ".cm-gutters",
  ".untitled-document__loss-reason", ".untitled-document__error",
  ".untitled-document__actions", ".dirty-close-guard", ".integrity-banner--external-change",
  ".external-change-compare", ".render-failure", ".shell-status--project-open",
  ".project-open-status__name", ".project-open-status__detail",
  ".shell-status--project-open .shell-status__message",
  ".shell-status--project-open .shell-status__dismiss",
  ".shell-status--project-open .shell-status__action",
  ".app-header__title", ".shell-status--unsupported-refusal",
  ".tab-bar__tab[data-recovery-content-omitted='true']", ".tab-bar__recovered-path",
  ".tab-bar__tab[data-recovery-content-omitted='true'] .tab-bar__recovery-dot",
  ".untitled-document__source-notice", ".untitled-document__conditions",
  ".dictation-mic", ".cm-dictation-ghost", ".cm-dictation-held-range", ".dictation-status-echo",
  ".tabbed-editor__session-status",
  ".message-input__field-wrap", ".message-input__field", ".message-input__send",
  ".comment-composer", ".comment-composer__body", ".comment-composer__cancel",
  ".comment-composer__submit", ".comment-composer .dictation-mic",
  ".composer-dictation-partial",
];
const evidence = {
  sourceRevision: null,
  viewport: "1400x900 except named narrow cases",
  deviceScaleFactor: 1,
  colorScheme: "light",
  captures: {},
  failures: [],
};
const processes = [];
let selectedScenarios = 0;

function fixture(name, content = "# Positioning brief\n\nA first draft of the product promise.\n") {
  const root = join(fixtureParent, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "notes.md"), content);
  return root;
}

async function post(driver, command, args = {}) {
  const response = await fetch(`${driver}/${command}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`${command}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function waitForServer(url, process, label) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`${label} exited with ${process.exitCode}`);
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`${label} did not start within 120 seconds`);
}

async function startServers() {
  const [vitePort, driverPort] = await allocateLoopbackPorts(2);
  const viteUrl = `http://127.0.0.1:${vitePort}`;
  const driverUrl = `http://127.0.0.1:${driverPort}`;
  const permissionProvider = process.env.EMEND_ALIGNMENT_SCENARIO?.includes("refresh23 dark")
    ? await buildPermissionProvider() : null;
  const env = {
    ...process.env,
    EMEND_CLAUDE_BIN: permissionProvider ?? "cowrite-test-no-claude-installed",
    EMEND_COPILOT_BIN: "cowrite-test-no-copilot-installed",
    ...(permissionProvider ? { EMEND_TEST_DRIVER_ALLOW_REAL_CLAUDE_SPAWN: "1" } : {}),
  };
  const vite = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
    cwd: repository,
    env: { ...env, VITE_TEST_DRIVER_URL: driverUrl },
    stdio: "ignore",
    detached: true,
  });
  const driver = spawn("cargo", ["run", "--quiet", "--manifest-path", "src-tauri/Cargo.toml", "-p", "test-driver", "--", String(driverPort)], {
    cwd: repository,
    env,
    stdio: "ignore",
    detached: true,
  });
  processes.push(vite, driver);
  await Promise.all([
    waitForServer(viteUrl, vite, "Vite"),
    waitForServer(driverUrl, driver, "D23 driver"),
  ]);
  return { viteUrl, driverUrl };
}

async function buildPermissionProvider() {
  const build = spawn("cargo", ["build", "--quiet", "--manifest-path", "src-tauri/Cargo.toml",
    "-p", "fake-agent", "--bin", "permission-provider"], {
    cwd: repository,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  build.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_768); });
  const [code, signal] = await once(build, "close");
  if (code !== 0) throw new Error(`permission provider build failed (${signal ?? code}): ${stderr}`);
  const target = resolve(process.env.CARGO_TARGET_DIR ?? join(repository, "src-tauri/target"));
  return join(target, "debug", `permission-provider${process.platform === "win32" ? ".exe" : ""}`);
}

async function newPage(browser, viteUrl, platform, width = 1400, height = 900, beforeGoto = null, colorScheme = "light") {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    colorScheme,
  });
  await context.addInitScript((reported) => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: reported });
  }, platform.navigatorPlatform);
  const page = await context.newPage();
  const setup = await beforeGoto?.(page);
  await page.goto(viteUrl);
  await page.locator(".app-header").waitFor();
  return { context, page, setup };
}

async function snapshot(page, name, target = null, metadata = {}) {
  const locator = target ? page.locator(target).first() : page;
  await locator.screenshot({ path: join(output, `${name}.png`), animations: "disabled" });
  evidence.captures[name] = await page.evaluate((probes) => {
    const measured = {};
    for (const selector of probes) {
      const element = document.querySelector(selector);
      if (!element || !element.getClientRects().length) continue;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      measured[selector] = {
        x: box.x, y: box.y, width: box.width, height: box.height,
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        background: style.backgroundColor, color: style.color,
        border: style.borderColor, borderRadius: style.borderRadius,
        boxShadow: style.boxShadow, opacity: style.opacity,
        fontFamily: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
        padding: style.padding, whiteSpace: style.whiteSpace,
        role: element.getAttribute("role"),
        ariaLive: element.getAttribute("aria-live"),
        ariaAtomic: element.getAttribute("aria-atomic"),
        ariaBusy: element.getAttribute("aria-busy"),
        containsFocus: element.contains(document.activeElement),
        text: (element.innerText ?? "").replace(/\s+/g, " ").slice(0, 420),
      };
    }
    const loadedFontFaces = [...document.fonts]
      .filter((face) => face.status === "loaded")
      .map((face) => `${face.family} ${face.style} ${face.weight}`)
      .sort();
    return { viewport: { width: innerWidth, height: innerHeight }, loadedFontFaces, measured };
  }, selectors);
  Object.assign(evidence.captures[name], metadata);
}

async function runScenario(name, run) {
  if (process.env.EMEND_ALIGNMENT_SCENARIO && !name.includes(process.env.EMEND_ALIGNMENT_SCENARIO)) return;
  selectedScenarios += 1;
  console.log(`Capturing ${name}`);
  try {
    await run();
  } catch (error) {
    evidence.failures.push({ scenario: name, error: String(error), stack: error?.stack });
  }
}

// D23 publishes real requesting/finished notices in one backend call. Split the poll after the
// requesting cursor and hold the next poll plus command response, so App renders the actual
// backend notice while the screenshot is taken. No routing outcome or notice is fabricated.
async function holdProjectRouting(page, driverUrl) {
  let active = null;
  await page.route(`${driverUrl}/events`, async (route) => {
    const response = await route.fetch();
    const batch = await response.json();
    const hold = active;
    if (!hold) {
      await route.fulfill({ response });
      return;
    }
    const requestingIndex = batch.events.findIndex((event) =>
      event.event === "cowrite://project/routing"
      && event.payload.status === "requesting"
      && event.payload.root === hold.root);
    if (hold.notice === null && requestingIndex >= 0) {
      const throughRequest = batch.events.slice(0, requestingIndex + 1);
      hold.notice = throughRequest.at(-1).payload;
      hold.resolveNotice();
      await route.fulfill({
        response,
        body: JSON.stringify({ ...batch, events: throughRequest, cursor: throughRequest.at(-1).cursor }),
      });
      return;
    }
    if (hold.notice !== null && batch.events.some((event) =>
      event.event === "cowrite://project/routing"
      && event.payload.status === "finished"
      && event.payload.request_id === hold.notice.request_id)) {
      hold.finishedNotice = batch.events.find((event) =>
        event.event === "cowrite://project/routing"
        && event.payload.status === "finished"
        && event.payload.request_id === hold.notice.request_id).payload;
      await hold.released;
    }
    await route.fulfill({ response });
  });
  await page.route(`${driverUrl}/route_project_open`, async (route) => {
    const hold = active?.root === route.request().postDataJSON().root ? active : null;
    if (!hold) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    hold.routeOutcome = await response.json();
    await hold.released;
    await route.fulfill({ response });
  });
  return {
    arm(root) {
      assert.equal(active, null, "only one J9 route may be held at a time");
      let release;
      let resolveNotice;
      const hold = {
        root, notice: null, finishedNotice: null, routeOutcome: null,
        noticeArrived: new Promise((resolveArrival) => { resolveNotice = resolveArrival; }),
        resolveNotice() { resolveNotice(); },
        released: new Promise((resolveRelease) => { release = resolveRelease; }),
        release() {
          if (active === hold) active = null;
          release();
        },
      };
      active = hold;
      return hold;
    },
  };
}

async function inspectProjectOpenBand(page) {
  return page.locator(".shell-status--project-open").evaluate((band) => {
    const message = band.querySelector(".shell-status__message");
    const dismiss = band.querySelector(".shell-status__dismiss");
    const fixed = [...band.querySelectorAll(".project-open-status__fixed")];
    const name = band.querySelector(".project-open-status__name");
    const detail = band.querySelector(".project-open-status__detail");
    const actions = [...band.querySelectorAll(".shell-status__action")];
    const action = actions[0] ?? null;
    if (!message || !dismiss || !name || fixed.length !== 2) {
      throw new Error("J9 band lacks its message parts or Dismiss control");
    }
    const visible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    return {
      text: message.textContent.replace(/\s+/g, " ").trim(),
      bandHeight: band.getBoundingClientRect().height,
      messageWhiteSpace: getComputedStyle(message).whiteSpace,
      messageHeight: message.getBoundingClientRect().height,
      prefixToNameGap: name.getBoundingClientRect().left - fixed[0].getBoundingClientRect().right,
      suffixToReasonGap: detail
        ? detail.getBoundingClientRect().left - fixed[1].getBoundingClientRect().right
        : null,
      dismissVisible: visible(dismiss),
      dismissFocusable: dismiss.tabIndex >= 0 && !dismiss.disabled,
      actionCount: actions.length,
      actionLabel: action?.innerText.trim() ?? null,
      actionFocusable: action !== null && visible(action) && action.tabIndex >= 0 && !action.disabled,
      actionAriaDisabled: action?.getAttribute("aria-disabled") === "true",
      actionFocused: action !== null && document.activeElement === action,
      actionOutlineWidth: action ? getComputedStyle(action).outlineWidth : "0px",
      ariaBusy: band.getAttribute("aria-busy") === "true",
    };
  });
}

async function captureHeldProjectOpen(page, platform, hold, name, state, expectedText) {
  let deadline;
  try {
    await Promise.race([
      hold.noticeArrived,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`No backend J9 requesting notice for ${hold.root}`)), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
  await page.locator(".shell-status--project-open").waitFor({ state: "visible" });
  if (state === "retry-pending") {
    await page.locator('.shell-status--project-open[aria-busy="true"] .shell-status__action').waitFor();
  }
  await page.evaluate(() => document.fonts.ready);
  assert.equal(hold.notice?.status, "requesting", "capture needs a real backend requesting notice");
  assert.equal(hold.notice.root, hold.root, "backend requesting notice has the fixture root");
  for (const width of [1400, 700, 520, 430]) {
    await page.setViewportSize({ width, height: 900 });
    const observed = await inspectProjectOpenBand(page);
    try {
      assertProjectOpenCapture(observed, { state, text: expectedText });
    } catch (error) {
      evidence.failures.push({ scenario: `${platform.id}-${name}-${width}`, stage: "before PNG", observed, error: String(error) });
      throw error;
    }
    await snapshot(page, `${platform.id}-${name}-${width}`,
      width === 1400 ? null : ".shell-status--project-open", {
        fixture: { kind: "real D23 route with held terminal transport", root: hold.root,
          backendRequestId: hold.notice.request_id, expectedState: state },
        sourceRevision: evidence.sourceRevision,
        verifiedState: observed,
      });
  }
}

async function captureHiddenProjectOpen(page, platform, hold, name) {
  await page.setViewportSize({ width: 1400, height: 900 });
  assert.equal(await page.locator(".shell-status--project-open").count(), 0,
    "Dismiss must hide the held project-open band");
  assert.equal(hold.notice?.status, "requesting", "the hidden line must be an in-flight backend request");
  await snapshot(page, `${platform.id}-${name}`, null, {
    fixture: { kind: "real D23 route with held terminal transport", root: hold.root,
      backendRequestId: hold.notice.request_id, expectedState: "dismissed-while-held" },
    sourceRevision: evidence.sourceRevision,
  });
}

async function captureCore(browser, viteUrl, driverUrl, platform) {
  const authoringContent = "# Positioning brief\n\nHello world.\n";
  const redlineContent = "# Positioning brief\n\nHello {--old--}{++new++} world.\n";
  const root = fixture(`${platform.id}-core`, authoringContent);
  await post(driverUrl, "close_project");
  for (const [id, author, body, filesRead] of [
    ["alignment-user", "user", "Tighten section two around one claim.", 0],
    ["alignment-agent", "agent", "I narrowed the claim and checked the supporting notes.", 2],
  ]) {
    await post(driverUrl, "append_transcript_event", {
      root,
      event: { schema_version: 1, id, kind: "chat-message", timestamp: "2026-09-30T12:00:00.000Z", author, body, filesRead },
    });
  }
  const { context, page } = await newPage(browser, viteUrl, platform);
  try {
    await page.getByRole("button", { name: "Open a folder…" }).waitFor();
    await snapshot(page, `${platform.id}-welcome`);
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, null), root);
    await page.locator(".app-body--workshop").waitFor();
    await page.locator('[data-card-kind="chat-message"]').last().waitFor();
    await snapshot(page, `${platform.id}-workshop`);
    await snapshot(page, `${platform.id}-cards`, ".timeline-panel__stream");
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.locator(".cm-content:visible").waitFor();
    await snapshot(page, `${platform.id}-authoring`);
    assert.equal(await page.locator(".cm-redlineInsert, .cm-redlineDelete").count(), 0, "authoring capture must show a document without pending changes");
    await page.getByRole("button", { name: "Close notes.md" }).click();
    writeFileSync(join(root, "notes.md"), redlineContent);
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.getByRole("group", { name: "Review changes" }).waitFor();
    await page.locator(".cm-redlineInsert").waitFor();
    await snapshot(page, `${platform.id}-redline`);
    await post(driverUrl, "propose_changes", {
      root,
      doc: "notes.md",
      baseContent: redlineContent,
      edits: [{ range: { offset: redlineContent.indexOf("Hello"), length: 0 }, replacement: "Better " }],
      summary: "Clarified the opening.",
    });
    await page.locator('[data-card-kind="change-set"]').last().waitFor();
    await snapshot(page, `${platform.id}-revision-card`, ".timeline-panel__stream");
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("dialog", { name: "Settings" }).waitFor();
    await snapshot(page, `${platform.id}-settings`);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureQuote(browser, viteUrl, driverUrl, platform) {
  const root = fixture(`${platform.id}-quote`, "Hello brave world.\n");
  await post(driverUrl, "close_project");
  const { context, page } = await newPage(browser, viteUrl, platform);
  try {
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.locator(".cm-content:visible").waitFor();
    await page.keyboard.press(platform.id === "mac" ? "Meta+Home" : "Control+Home");
    for (let index = 0; index < 5; index += 1) await page.keyboard.press("Shift+ArrowRight");
    await page.getByRole("button", { name: "Quote to chat" }).click();
    await page.getByRole("note", { name: "Quoted selection" }).waitFor();
    await snapshot(page, `${platform.id}-quote-bar`, ".timeline-panel");
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureComment(browser, viteUrl, driverUrl, platform) {
  const content = "A paragraph with a selected phrase for a comment.\n";
  const root = fixture(`${platform.id}-comment`, content);
  await post(driverUrl, "create_comment", {
    root,
    path: "notes.md",
    author: "alice",
    body: "Please clarify this passage.",
    anchor: {
      content,
      utf16Offset: content.indexOf("selected phrase"),
      utf16Length: "selected phrase".length,
    },
    timestamp: 0,
  });
  await post(driverUrl, "close_project");
  const { context, page } = await newPage(browser, viteUrl, platform);
  try {
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.locator(".cm-commentHighlight").click();
    const popover = page.getByRole("dialog", { name: "Comment thread" });
    await popover.waitFor();
    await snapshot(page, `${platform.id}-comment-open`, ".comment-popover");
    await popover.getByRole("button", { name: "Resolve" }).click();
    await popover.getByRole("button", { name: /^Expand/ }).click();
    await snapshot(page, `${platform.id}-comment-resolved`, ".comment-popover");
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

const j10Content = "A selected phrase remains in the document.\n";

async function j10Thread(driverUrl, root, content) {
  const [thread] = await post(driverUrl, "create_comment", {
    root, path: "notes.md", author: "you", body: "Please clarify this passage.",
    anchor: { content, utf16Offset: content.indexOf("selected phrase"), utf16Length: "selected phrase".length },
    timestamp: Date.now() - 120_000,
  });
  return thread;
}

function j10Publish(root, threadId) {
  // Review sync is not yet wired, so seed its published event using the D20 sidecar schema.
  const [docId] = readdirSync(join(root, ".emend", "comments"));
  appendFileSync(join(root, ".emend", "comments", docId, "cowrite.jsonl"), JSON.stringify({
    schema_version: 1, id: `publish-${threadId}`, parent_id: threadId,
    author: "cowrite", timestamp: Date.now() - 90_000, type: "publish",
  }) + "\n");
}

async function j10Page(browser, viteUrl, driverUrl, platform, root) {
  await post(driverUrl, "close_project");
  const opened = await newPage(browser, viteUrl, platform);
  try {
    await opened.page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    const fontFaces = await opened.page.evaluate(async () => {
      const required = [...document.fonts].filter((face) => /IBM Plex Sans|IBM Plex Mono|Source Serif 4/.test(face.family));
      await Promise.all(required.map((face) => face.load()));
      return required.map((face) => ({ family: face.family, status: face.status }));
    });
    assert.ok(fontFaces.length >= 3, "J10 captures require the bundled font faces");
    assert.ok(fontFaces.every((face) => face.status === "loaded"), "J10 captures may not use fallback fonts");
    const card = opened.page.locator('.timeline-panel [data-card-kind="comment"]').first();
    await card.waitFor();
    return { ...opened, card };
  } catch (error) {
    await opened.context.close();
    throw error;
  }
}

async function j10Popover(page) {
  await page.locator(".cm-commentHighlight").first().click();
  const popover = page.getByRole("dialog", { name: "Comment thread" });
  await popover.waitFor();
  return popover;
}

async function captureJ10Blocked(browser, viteUrl, driverUrl, platform) {
  const content = j10Content;
  const root = fixture(`${platform.id}-j10-blocked`, content);
  const thread = await j10Thread(driverUrl, root, content);
  await post(driverUrl, "reply_comment", {
    root, path: "notes.md", threadId: thread.id, author: "alice", body: "I still need the source.",
    defense: false, published: false, timestamp: Date.now() - 60_000,
  });
  const { context, page, card } = await j10Page(browser, viteUrl, driverUrl, platform, root);
  try {
    await card.getByText("I still need the source.").waitFor();
    await card.getByRole("button", { name: "Comment actions" }).click();
    assert.equal(await card.getByRole("button", { name: "Delete comment" }).isDisabled(), true);
    assert.equal(await card.getByText("Delete replies first.").count(), 1);
    assert.equal(await card.getByText("Delete this comment?").count(), 0);
    await snapshot(page, `${platform.id}-5d-root-blocked-timeline`, ".timeline-panel");

    const popover = await j10Popover(page);
    await popover.getByRole("button", { name: "Comment actions" }).click();
    assert.equal(await popover.getByRole("button", { name: "Delete comment" }).isDisabled(), true);
    assert.equal(await popover.getByText("Delete replies first.").count(), 1);
    await snapshot(page, `${platform.id}-5d-root-blocked-popover`, ".comment-popover");
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureJ10Nested(browser, viteUrl, driverUrl, platform) {
  const content = j10Content;
  const root = fixture(`${platform.id}-j10-nested`, content);
  const thread = await j10Thread(driverUrl, root, content);
  const afterReply = await post(driverUrl, "reply_comment", {
    root, path: "notes.md", threadId: thread.id, author: "you", body: "My answer.",
    defense: false, published: false, timestamp: Date.now() - 60_000,
  });
  const ownReply = afterReply[0].replies.find((reply) => reply.body === "My answer.");
  assert.ok(ownReply, "own reply must be persisted");
  await post(driverUrl, "reply_comment", {
    root, path: "notes.md", threadId: ownReply.id, author: "alice", body: "Nested follow-up.",
    defense: false, published: false, timestamp: Date.now() - 30_000,
  });
  const { context, page, card } = await j10Page(browser, viteUrl, driverUrl, platform, root);
  try {
    await card.getByText("Nested follow-up.").waitFor();
    await card.locator(".comment-thread-card__replies summary").click();
    await card.getByText("My answer.").waitFor();
    await card.getByRole("button", { name: "Reply actions" }).click();
    assert.equal(await card.getByRole("button", { name: "Delete reply" }).isDisabled(), true);
    assert.equal(await card.getByText("Delete replies first.").count(), 1);
    await snapshot(page, `${platform.id}-5d-nested-blocked-timeline`, ".timeline-panel");
    const popover = await j10Popover(page);
    await popover.locator(".comment-thread-card__replies summary").click();
    await popover.getByRole("button", { name: "Reply actions" }).click();
    assert.equal(await popover.getByRole("button", { name: "Delete reply" }).isDisabled(), true);
    assert.equal(await popover.getByText("Delete replies first.").count(), 1);
    await snapshot(page, `${platform.id}-5d-nested-blocked-popover`, ".comment-popover");
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureJ10Eligible(browser, viteUrl, driverUrl, platform) {
  const content = j10Content;
  const root = fixture(`${platform.id}-j10-eligible`, content);
  const thread = await j10Thread(driverUrl, root, content);
  j10Publish(root, thread.id);
  const afterReply = await post(driverUrl, "reply_comment", {
    root, path: "notes.md", threadId: thread.id, author: "you", body: "An earlier answer.",
    defense: false, published: false, timestamp: Date.now() - 60_000,
  });
  const ownReply = afterReply[0].replies.find((reply) => reply.body === "An earlier answer.");
  assert.ok(ownReply);
  await post(driverUrl, "withdraw_own_comment", {
    root, path: "notes.md", targetId: ownReply.id, timestamp: Date.now() - 30_000,
  });
  const { context, page, card } = await j10Page(browser, viteUrl, driverUrl, platform, root);
  try {
    await card.getByText("deleted a reply").waitFor();
    await card.getByRole("button", { name: "Comment actions" }).click();
    assert.equal(await card.getByRole("button", { name: "Delete comment" }).isEnabled(), true);
    await card.getByRole("button", { name: "Delete comment" }).click();
    await card.getByText("Delete this comment?").waitFor();
    assert.equal(await card.getByText("An earlier answer.").count(), 0);
    const timelineControls = await eligibleConfirmationControls(card);
    await snapshot(page, `${platform.id}-5d-eligible-timeline`, ".timeline-panel", {
      confirmationControls: timelineControls,
    });
    await card.getByRole("button", { name: "Cancel" }).click();

    const popover = await j10Popover(page);
    await popover.getByRole("button", { name: "Comment actions" }).click();
    await popover.getByRole("button", { name: "Delete comment" }).click();
    await popover.getByText("Delete this comment?").waitFor();
    assert.equal(await popover.getByText("deleted a reply").count(), 1);
    const popoverControls = await eligibleConfirmationControls(popover);
    await snapshot(page, `${platform.id}-5d-eligible-popover`, ".comment-popover", {
      confirmationControls: popoverControls,
    });
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function eligibleConfirmationControls(target) {
  const controls = {
    replyTextboxes: await target.getByRole("textbox", { name: /^Reply to/ }).count(),
    addressButtons: await target.getByRole("button", { name: "Address with AI", exact: true }).count(),
  };
  assert.deepEqual(controls, { replyTextboxes: 0, addressButtons: 0 },
    "ordinary Reply and Address with AI controls must hide during Delete confirmation");
  return controls;
}

async function captureJ10CommitRefusal(browser, viteUrl, driverUrl, platform, surface) {
  const content = j10Content;
  const root = fixture(`${platform.id}-j10-refusal-${surface}`, content);
  const thread = await j10Thread(driverUrl, root, content);
  const { context, page, card } = await j10Page(browser, viteUrl, driverUrl, platform, root);
  try {
    const target = surface === "popover" ? await j10Popover(page) : card;
    await target.getByRole("button", { name: "Comment actions" }).click();
    await target.getByRole("button", { name: "Delete comment" }).click();
    await target.getByText("Delete this comment?").waitFor();
    await post(driverUrl, "reply_comment", {
      root, path: "notes.md", threadId: thread.id, author: "alice", body: "Late reply from Alice.",
      defense: false, published: false, timestamp: Date.now(),
    });
    await target.getByRole("button", { name: "Delete", exact: true }).click();
    await target.getByText("Not deleted").waitFor();
    await target.getByText("Late reply from Alice.").waitFor();
    assert.equal(await target.getByText("Delete replies first.").count(), 1);
    assert.equal(await target.getByRole("button", { name: "Comment actions" }).evaluate((button) => button === document.activeElement), true);
    await snapshot(page, `${platform.id}-5d-commit-refusal-${surface}`, surface === "popover" ? ".comment-popover" : ".timeline-panel");
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureJ10Withdrawn(browser, viteUrl, driverUrl, platform) {
  const content = j10Content;
  const root = fixture(`${platform.id}-j10-withdrawn`, content);
  const thread = await j10Thread(driverUrl, root, content);
  j10Publish(root, thread.id);
  const { context, page, card } = await j10Page(browser, viteUrl, driverUrl, platform, root);
  try {
    await card.getByRole("button", { name: "Comment actions" }).click();
    await card.getByRole("button", { name: "Delete comment" }).click();
    await card.getByText("Others may already have seen this comment.", { exact: false }).waitFor();
    await card.getByRole("button", { name: "Delete", exact: true }).click();
    await card.getByText("deleted a comment").waitFor();
    assert.equal(await card.getByText("Please clarify this passage.").count(), 0);
    const passageRoute = card.getByRole("button", { name: "→ Go to passage" });
    assert.equal(await passageRoute.count(), 1);
    await snapshot(page, `${platform.id}-5d-withdrawn-timeline`, ".timeline-panel");
    await passageRoute.focus();
    await passageRoute.press("Enter");
    await page.waitForFunction(() => document.querySelector(".cm-editor")?.classList.contains("cm-focused")
      && window.getSelection()?.toString() === "selected phrase");
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureJ10Linked(browser, viteUrl, driverUrl, platform) {
  const content = j10Content;
  const root = fixture(`${platform.id}-j10-linked`, content);
  const thread = await j10Thread(driverUrl, root, content);
  const delivered = await post(driverUrl, "propose_changes", {
    root, doc: "notes.md", baseContent: content,
    edits: [
      { range: { offset: content.length, length: 0 }, replacement: "A source note.\n" },
      { range: { offset: 0, length: 0 }, replacement: "Context: " },
    ],
    summary: "Two linked clarifications.",
  });
  assert.equal(delivered.changes.length, 2);
  await post(driverUrl, "link_changes", {
    root, path: "notes.md", threadId: thread.id, author: "agent", timestamp: Date.now(),
    changeIds: delivered.changes.map((change) => change.changeId),
  });
  const { context, page, card } = await j10Page(browser, viteUrl, driverUrl, platform, root);
  try {
    await card.getByText("2 linked changes still to decide.", { exact: false }).waitFor();
    assert.equal(await card.getByRole("button", { name: "Go to changes" }).count(), 1);
    assert.equal(await card.getByRole("button", { name: /Resolve — 2 linked/ }).isDisabled(), true);
    await snapshot(page, `${platform.id}-5d-linked-reason-timeline`, ".timeline-panel");
    await card.getByRole("button", { name: "Comment actions" }).click();
    assert.equal(await card.getByRole("button", { name: "Delete comment" }).isDisabled(), true);
    await snapshot(page, `${platform.id}-5d-linked-timeline`, ".timeline-panel");
    const popover = await j10Popover(page);
    await snapshot(page, `${platform.id}-5d-linked-reason-popover`, ".comment-popover");
    await popover.getByRole("button", { name: "Comment actions" }).click();
    assert.equal(await popover.getByRole("button", { name: "Go to changes" }).count(), 1);
    await snapshot(page, `${platform.id}-5d-linked-popover`, ".comment-popover");
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureJ10RunHeld(browser, viteUrl, driverUrl, platform) {
  const content = j10Content;
  const root = fixture(`${platform.id}-j10-run-held`, content);
  const thread = await j10Thread(driverUrl, root, content);
  // The document has already loaded before a user starts Address. Mark that normal first load
  // in the D23 process so startup's abandoned-run reconciliation does not rewrite this new run.
  await post(driverUrl, "load_comment_threads", { root, path: "notes.md" });
  await post(driverUrl, "address_with_ai", {
    root, path: "notes.md", threadId: thread.id, author: "you", timestamp: Date.now(),
    runId: `j10-held-${platform.id}`,
  });
  const { context, page, card } = await j10Page(browser, viteUrl, driverUrl, platform, root);
  try {
    await card.getByText("Addressing with AI", { exact: false }).waitFor();
    assert.equal(await card.getByRole("button", { name: "Edit comment" }).isDisabled(), true);
    await snapshot(page, `${platform.id}-5d-run-held-status-timeline`, ".timeline-panel");
    await card.getByRole("button", { name: "Comment actions" }).click();
    assert.equal(await card.getByRole("button", { name: "Delete comment" }).isDisabled(), true);
    assert.equal(await card.getByRole("button", { name: "Resolve", exact: true }).isEnabled(), true);
    await snapshot(page, `${platform.id}-5d-run-held-timeline`, ".timeline-panel");
    const popover = await j10Popover(page);
    await snapshot(page, `${platform.id}-5d-run-held-status-popover`, ".comment-popover");
    await popover.getByRole("button", { name: "Comment actions" }).click();
    assert.equal(await popover.getByRole("button", { name: "Delete comment" }).isDisabled(), true);
    await snapshot(page, `${platform.id}-5d-run-held-popover`, ".comment-popover");
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureRail(browser, viteUrl, driverUrl, platform) {
  const root = fixture(`${platform.id}-rail`);
  writeFileSync(join(root, "other.md"), "# Other document\n");
  await post(driverUrl, "close_project");
  const { context, page } = await newPage(browser, viteUrl, platform);
  try {
    const held = [];
    let hold = true;
    const holdScan = async (route) => {
      if (hold) await new Promise((resolveRelease) => held.push(resolveRelease));
      await route.continue();
    };
    await page.route(`${driverUrl}/refresh_project_files`, holdScan);
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.getByText("Loading documents…").waitFor();
    await snapshot(page, `${platform.id}-rail-loading`);
    hold = false;
    held.splice(0).forEach((release) => release());
    await page.locator(".project-rail__tree").waitFor();
    await page.unroute(`${driverUrl}/refresh_project_files`, holdScan);
    await snapshot(page, `${platform.id}-rail-ready`);

    hold = true;
    await page.route(`${driverUrl}/refresh_project_files`, holdScan);
    await page.getByRole("button", { name: "Refresh project files" }).click();
    await page.getByText("Updating documents…").waitFor();
    await snapshot(page, `${platform.id}-rail-updating`);
    hold = false;
    held.splice(0).forEach((release) => release());
    await page.getByText("Updating documents…").waitFor({ state: "hidden" });
    await page.unroute(`${driverUrl}/refresh_project_files`, holdScan);
    await page.route(`${driverUrl}/refresh_project_files`, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ kind: "UpdateFailed", message: "Alignment fixture scan failure" }),
      });
    }, { times: 1 });
    await page.getByRole("button", { name: "Refresh project files" }).click();
    await page.getByText("Couldn’t update documents").waitFor();
    await snapshot(page, `${platform.id}-rail-update-failed`);
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureRailUnavailable(browser, viteUrl, driverUrl, platform) {
  const root = fixture(`${platform.id}-rail-unavailable`);
  await post(driverUrl, "close_project");
  const { context, page } = await newPage(browser, viteUrl, platform);
  try {
    await page.route(`${driverUrl}/refresh_project_files`, async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ kind: "ProjectUnavailable", message: "Alignment fixture scan failure" }),
      });
    });
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.getByText("Project files unavailable").waitFor();
    await snapshot(page, `${platform.id}-rail-unavailable`);
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureIntegrity(browser, viteUrl, driverUrl, platform) {
  const root = fixture(`${platform.id}-integrity`, "Original disk bytes");
  await post(driverUrl, "close_project");
  const { context, page } = await newPage(browser, viteUrl, platform);
  try {
    await page.evaluate(() => {
      window.__EMEND_E2E__?.setAutosaveIntervalMs(5_000);
      window.__EMEND_E2E__?.setExternalChangePollMs(1_000);
    });
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    const editor = page.locator(".cm-content:visible");
    await editor.waitFor();
    await editor.click();
    await page.keyboard.press(platform.id === "mac" ? "Meta+A" : "Control+A");
    await page.keyboard.type("Emend's unsaved local edit");
    writeFileSync(join(root, "notes.md"), "A concurrent editor's bytes");
    await page.getByText("This file changed outside the editor").waitFor();
    await snapshot(page, `${platform.id}-11-changed-on-disk`);
    await page.keyboard.press(platform.id === "mac" ? "Meta+S" : "Control+S");
    await page.getByText("Not saved — this file changed outside the editor").waitFor();
    await snapshot(page, `${platform.id}-11-blocked-save`);
    await page.getByRole("button", { name: "Compare" }).click();
    await page.locator(".external-change-compare").waitFor();
    await snapshot(page, `${platform.id}-11-compare`);
    await page.locator(".external-change-compare").getByRole("button", { name: "Close" }).click();

    // Hold the D23 transport after Reload has replaced the buffer. This keeps the real editor's
    // recovery write pending long enough to capture the bannerless 11c.4 phase, then produces its
    // honest failed-write state without replacing the application participant.
    let releaseSave;
    const saveReleased = new Promise((resolveRelease) => { releaseSave = resolveRelease; });
    const holdRecoveryWrite = async (route) => {
      await saveReleased;
      await route.abort("failed");
    };
    await page.route(`${driverUrl}/save_document`, holdRecoveryWrite);
    try {
      const saveIssued = page.waitForRequest(`${driverUrl}/save_document`);
      await page.getByRole("button", { name: "Reload", exact: true }).click();
      await saveIssued;
      await page.getByText("Reloaded from disk · not saved yet").waitFor();
      await snapshot(page, `${platform.id}-11-write-pending`);
      releaseSave();
      await page.getByText("The version from disk is here, but it isn’t saved").waitFor();
      await snapshot(page, `${platform.id}-11-failed-reload`);
    } finally {
      releaseSave();
      await page.unroute(`${driverUrl}/save_document`, holdRecoveryWrite);
    }
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureRecovery(browser, viteUrl, driverUrl, platform) {
  const root = fixture(`${platform.id}-recovery`, "# The moved document now at this path\n");
  const recoveryPath = "untitled:1:notes.md";
  mkdirSync(join(root, ".emend"), { recursive: true });
  writeFileSync(join(root, ".emend", "tab-session.json"), JSON.stringify({
    schema_version: 1,
    tabs: [{
      path: recoveryPath,
      unsaved_content: null,
      recovered_from: "notes.md",
      unsaved_content_omitted: true,
      loss_notice_collapsed: false,
    }],
    active_path: recoveryPath,
  }));
  await post(driverUrl, "close_project");
  const { context, page } = await newPage(browser, viteUrl, platform);
  try {
    await page.evaluate((value) => window.__EMEND_E2E__?.openProject(value.root, value.path), { root, path: recoveryPath });
    await page.locator(".untitled-document__loss-notice").waitFor();
    // The 9-series tiles specify document-column widths; the browser viewport keeps the real
    // project rail and timeline alongside the pane, as the acceptance fixture does.
    const sideWidth = await page.evaluate(() =>
      document.querySelector(".project-rail").getBoundingClientRect().width
      + document.querySelector(".timeline-panel").getBoundingClientRect().width);
    for (const paneWidth of [660, 420, 330]) {
      await page.setViewportSize({ width: Math.round(sideWidth + paneWidth + 1), height: 900 });
      await snapshot(page, `${platform.id}-9c2-${paneWidth}`, ".untitled-document");
    }
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.getByRole("button", { name: "Hide message" }).click();
    await snapshot(page, `${platform.id}-9c3-collapsed`, ".untitled-document");
    await page.getByRole("button", { name: "Earlier unsaved work not preserved — show details" }).click();
    await page.getByRole("button", { name: /Close Untitled/ }).click();
    await page.getByRole("alertdialog").waitFor();
    await snapshot(page, `${platform.id}-9c5-empty-guard`);
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("textbox", { name: "Untitled document text" }).fill("New work in this buffer.");
    await snapshot(page, `${platform.id}-9c4-edited`, ".untitled-document");
    await page.getByRole("button", { name: /Close Untitled/ }).click();
    await page.getByRole("alertdialog").waitFor();
    await snapshot(page, `${platform.id}-9c5-edited-guard`);
    await page.getByRole("button", { name: "Cancel" }).click();
    const blockedDestination = join(root, "blocked.md");
    mkdirSync(blockedDestination);
    await page.evaluate((path) => window.__EMEND_E2E__?.setNextSaveAsDialogResult(path), blockedDestination);
    await page.getByRole("button", { name: "Save As…" }).click();
    await page.locator(".untitled-document__error").waitFor();
    await snapshot(page, `${platform.id}-9c6-save-as-failed`, ".untitled-document");
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function inspectLegacyUnsupported(page) {
  return page.evaluate(() => {
    const element = (selector) => document.querySelector(selector);
    const text = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
    const before = (first, second) => Boolean(first && second
      && (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING));
    const toolbar = element(".view-mode-toolbar");
    const source = element(".untitled-document__source-notice");
    const loss = element(".untitled-document__loss-notice");
    const standing = element(".untitled-document__conditions");
    const band = element(".shell-status--unsupported-refusal");
    const dismiss = band?.querySelector(".shell-status__dismiss");
    const message = band?.querySelector(".shell-status__message");
    const omissionMarker = element(".tab-bar__tab[data-recovery-content-omitted='true'] .tab-bar__recovery-dot");
    return {
      title: text(element(".app-header__title")),
      activeTab: element(".tab-bar__tab[aria-selected='true']")?.getAttribute("aria-label") ?? null,
      directFormerTabCount: [...document.querySelectorAll(".tab-bar__tab")]
        .filter((tab) => tab.getAttribute("aria-label")?.startsWith("research/survey-export.csv")).length,
      omissionTabCount: document.querySelectorAll(".tab-bar__tab[data-recovery-content-omitted='true']").length,
      omissionMarkerVisible: Boolean(omissionMarker && omissionMarker.getClientRects().length
        && omissionMarker.getBoundingClientRect().width === 6
        && omissionMarker.getBoundingClientRect().height === 6),
      omissionMarkerBackground: omissionMarker ? getComputedStyle(omissionMarker).backgroundColor : null,
      recoveredPath: text(element(".tab-bar__recovered-path")),
      sourceText: text(source),
      sourceBackground: source ? getComputedStyle(source).backgroundColor : null,
      lossText: text(loss),
      standingText: text(standing),
      bufferText: text(element(".cm-content")),
      saveAsCount: [...document.querySelectorAll("button")]
        .filter((button) => button.textContent.trim() === "Save As…").length,
      toolbarBeforeSource: before(toolbar, source),
      sourceBeforeLoss: before(source, loss),
      sourceBeforeStanding: before(source, standing),
      lossBeforeStanding: before(loss, standing),
      standingBeforeBuffer: before(standing, element(".cm-content")),
      refusalText: text(message),
      refusalHeight: band?.getBoundingClientRect().height ?? null,
      refusalLineHeight: message?.getBoundingClientRect().height ?? null,
      refusalWhiteSpace: message ? getComputedStyle(message).whiteSpace : null,
      refusalDismissFocusable: Boolean(dismiss && dismiss.tabIndex >= 0 && !dismiss.disabled
        && dismiss.getBoundingClientRect().width > 0),
    };
  });
}

function assertLegacyUnsupported(observed, platform, state) {
  const formerPath = "research/survey-export.csv";
  if (state === "retained" || state === "composed") {
    assert.equal(observed.title,
      `${platform.id === "win" ? "Emend — " : ""}Untitled — from ${formerPath}`);
    assert.match(observed.activeTab, /Untitled — recovered from research\/survey-export\.csv/);
    assert.equal(observed.recoveredPath, formerPath);
    assert.equal(observed.directFormerTabCount, 0);
    assert.match(observed.sourceText, /unsaved text this tab held is here, in an untitled document you can edit/);
    assert.match(observed.sourceText, /not to the original file/);
    assert.ok(observed.toolbarBeforeSource && observed.sourceBeforeStanding
      && observed.standingBeforeBuffer, "D27 source notice must follow toolbar and precede standing/buffer");
    assert.ok(observed.saveAsCount > 0, "D27 retained text needs Save As");
    assert.match(observed.bufferText, /retained rows/);
    assert.equal(observed.omissionTabCount, state === "composed" ? 1 : 0);
    assert.equal(observed.omissionMarkerVisible, state === "composed");
    if (state === "composed") {
      assert.ok(observed.sourceBeforeLoss && observed.lossBeforeStanding,
        "earlier omission stays below the neutral source notice");
      assert.match(observed.lossText, /earlier unsaved work/);
      assert.match(observed.lossText, /doesn’t bring back what wasn’t/);
    } else {
      assert.equal(observed.lossText, "", "retained-only recovery must not claim an omission");
    }
  } else {
    assert.match(observed.refusalText, /research\/survey-export\.csv can’t open as an Emend document/);
    assert.equal(observed.refusalHeight, 46);
    assert.equal(observed.refusalWhiteSpace, "nowrap");
    assert.ok(observed.refusalLineHeight <= 21, "D27 refusal must remain one line");
    assert.ok(observed.refusalDismissFocusable, "D27 refusal needs focusable Dismiss");
    assert.equal(observed.sourceText, "", "refusal has no recovered source notice");
    if (state === "clean-refusal") {
      assert.match(observed.refusalText, /Its tab was closed/);
      assert.equal(observed.directFormerTabCount, 0);
      assert.equal(observed.omissionTabCount, 0);
      assert.equal(observed.omissionMarkerVisible, false);
    } else {
      assert.match(observed.refusalText, /wasn’t kept/);
      assert.equal(observed.directFormerTabCount, 1, "CJ ruled omission-only tab remains");
      assert.equal(observed.omissionTabCount, 1, "CJ ruled omission marker remains");
      assert.equal(observed.omissionMarkerVisible, true, "omission-only tab must visibly mark the loss");
      assert.equal(observed.omissionMarkerBackground, "rgb(181, 135, 31)");
      assert.match(observed.activeTab, /earlier unsaved work was not preserved/);
      assert.doesNotMatch(observed.activeTab, /Untitled — recovered/,
        "omission-only state must not invent an editable recovery document");
    }
  }
}

async function captureLegacyUnsupported(browser, viteUrl, driverUrl, platform) {
  const formerPath = "research/survey-export.csv";
  const retainedText = "retained rows\nsecond row\n";
  const originalText = "original source rows\n";
  for (const state of ["retained", "composed", "clean-refusal", "omission-refusal"]) {
    const root = fixture(`${platform.id}-d27-${state}`);
    mkdirSync(join(root, "research"), { recursive: true });
    writeFileSync(join(root, formerPath), originalText);
    mkdirSync(join(root, ".emend"), { recursive: true });
    writeFileSync(join(root, ".emend", "tab-session.json"), JSON.stringify({
      schema_version: 1,
      tabs: [
        { path: formerPath,
          unsaved_content: state === "retained" || state === "composed" ? retainedText : null,
          unsaved_content_omitted: state === "composed" || state === "omission-refusal" },
        { path: "notes.md", unsaved_content: null },
      ],
      active_path: formerPath,
    }));
    await post(driverUrl, "close_project");
    const { context, page } = await newPage(browser, viteUrl, platform);
    try {
      await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProjectFolder(projectRoot), root);
      if (state === "retained" || state === "composed") {
        await page.getByRole("region", { name: "Unsupported document recovery notice" }).waitFor();
      } else {
        await page.locator(".shell-status--unsupported-refusal").waitFor();
      }
      await page.evaluate(() => document.fonts.ready);
      const metadata = (verifiedState) => ({
        fixture: { kind: "real version-1 legacy restored session", root, formerPath, state },
        sourceRevision: evidence.sourceRevision,
        verifiedState,
      });
      await page.setViewportSize({ width: 1400, height: 900 });
      let observed = await inspectLegacyUnsupported(page);
      assertLegacyUnsupported(observed, platform, state);
      await snapshot(page, `${platform.id}-9h-${state}-1400`, null, metadata(observed));
      if (state === "retained" || state === "composed") {
        const sideWidth = await page.evaluate(() =>
          document.querySelector(".project-rail").getBoundingClientRect().width
          + document.querySelector(".timeline-panel").getBoundingClientRect().width);
        const widths = state === "retained" ? [660, 440, 330] : [440, 330];
        for (const paneWidth of widths) {
          await page.setViewportSize({ width: Math.round(sideWidth + paneWidth + 1), height: 900 });
          observed = await inspectLegacyUnsupported(page);
          assertLegacyUnsupported(observed, platform, state);
          await snapshot(page, `${platform.id}-9h-${state}-${paneWidth}`,
            ".untitled-document", metadata(observed));
        }
        if (state === "retained") {
          await page.setViewportSize({ width: 1400, height: 900 });
          const destination = join(root, "recovered.md");
          await page.evaluate((path) => window.__EMEND_E2E__?.setNextSaveAsDialogResult(path), destination);
          await page.getByRole("button", { name: "Save As…" }).click();
          await page.getByRole("tab", { name: "recovered.md" }).waitFor();
          assert.equal(readFileSync(destination, "utf8"), retainedText);
          assert.equal(readFileSync(join(root, formerPath), "utf8"), originalText);
          assert.equal(await page.getByRole("region", { name: "Unsupported document recovery notice" }).count(), 0);
          observed = await inspectLegacyUnsupported(page);
          assert.equal(observed.title, `${platform.id === "win" ? "Emend — " : ""}recovered.md`);
          await snapshot(page, `${platform.id}-9h-adopted-1400`, null,
            metadata({ ...observed, adoptedDestination: destination }));
        }
      } else {
        await page.setViewportSize({ width: 430, height: 900 });
        observed = await inspectLegacyUnsupported(page);
        assertLegacyUnsupported(observed, platform, state);
        await snapshot(page, `${platform.id}-9h-${state}-430`,
          ".shell-status--unsupported-refusal", metadata(observed));
      }
    } finally {
      await context.close();
      await post(driverUrl, "close_project");
    }
  }
}

async function capturePathless(browser, viteUrl, driverUrl, platform) {
  const content = "Alpha claim. Beta";
  const root = fixture(`${platform.id}-pathless`, "# The moved document now at this path\n");
  const recoveryPath = "untitled:1:notes.md";
  mkdirSync(join(root, ".emend"), { recursive: true });
  writeFileSync(join(root, ".emend", "tab-session.json"), JSON.stringify({
    schema_version: 1,
    tabs: [{ path: recoveryPath, unsaved_content: content, recovered_from: "notes.md" }],
    active_path: recoveryPath,
  }));
  await post(driverUrl, "close_project");
  const { context, page } = await newPage(browser, viteUrl, platform);
  try {
    await page.evaluate(({ projectRoot, path }) => window.__EMEND_E2E__?.openProject(projectRoot, path), {
      projectRoot: root, path: recoveryPath,
    });
    const editor = page.getByRole("textbox", { name: "Untitled document text" });
    await editor.waitFor();
    assert.equal((await editor.textContent()).trim(), content);
    const selectAlpha = async () => {
      await editor.focus();
      await page.keyboard.press(platform.id === "mac" ? "Meta+Home" : "Control+Home");
      for (let index = 0; index < 5; index += 1) await page.keyboard.press("Shift+ArrowRight");
    };
    const selectBeta = async () => {
      await editor.focus();
      await page.keyboard.press(platform.id === "mac" ? "Meta+End" : "Control+End");
      for (let index = 0; index < 4; index += 1) await page.keyboard.press("Shift+ArrowLeft");
    };
    const assertSelectionFitsColumn = async (paneWidth, selectionLabel) => {
      // Let the column's ResizeObserver settle after the viewport change before reading its box.
      await page.evaluate(() => new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await page.evaluate(() => {
        const column = document.querySelector(".untitled-document").getBoundingClientRect();
        const actions = document.querySelector(".editor-shell__selection-affordances").getBoundingClientRect();
        return {
          column: { left: column.left, right: column.right },
          actions: { left: actions.left, right: actions.right },
        };
      });
      assert.ok(geometry.actions.left >= geometry.column.left - 0.25
        && geometry.actions.right <= geometry.column.right + 0.25,
      `${platform.id} ${paneWidth}px ${selectionLabel} selection actions leave document column: ${JSON.stringify(geometry)}`);
    };
    await selectAlpha();
    await page.getByRole("button", { name: "Comment", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Quote to chat" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Ask agent" }).count(), 0);
    assert.equal(await page.locator(".document-status-bar").getByText(/open comments?/).count(), 0);

    // These are document-column widths from `9g`, inside a real shell with both rails mounted.
    const sideWidth = await page.evaluate(() =>
      document.querySelector(".project-rail").getBoundingClientRect().width
      + document.querySelector(".timeline-panel").getBoundingClientRect().width);
    for (const paneWidth of [660, 420, 330]) {
      await page.setViewportSize({ width: Math.round(sideWidth + paneWidth + 1), height: 900 });
      await page.getByRole("button", { name: "Comment", exact: true }).waitFor();
      await assertSelectionFitsColumn(paneWidth, "Alpha");
      await snapshot(page, `${platform.id}-9g-0-comments-${paneWidth}`, ".untitled-document");
    }

    await page.getByRole("button", { name: "Quote to chat" }).click();
    const quotedSelection = page.getByRole("note", { name: "Quoted selection" });
    await quotedSelection.waitFor();
    assert.match(await quotedSelection.textContent(), /Alpha/);
    await quotedSelection.getByRole("button", { name: "Remove quote" }).click();
    await selectAlpha();
    await page.getByRole("button", { name: "Comment", exact: true }).focus();
    await page.keyboard.press("Enter");
    let composer = page.getByRole("dialog", { name: "New comment" });
    await composer.getByLabel("Comment").fill("The first anchored comment.");
    await composer.getByRole("button", { name: "Comment", exact: true }).click();
    await page.locator(".cm-commentHighlight").first().waitFor();
    await selectBeta();
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    composer = page.getByRole("dialog", { name: "New comment" });
    await composer.getByLabel("Comment").fill("The second anchored comment.");
    await composer.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByText("2 open comments").waitFor();
    assert.equal(await page.locator(".cm-commentHighlight").count(), 2);
    assert.equal(await page.locator(".cm-commentHighlight[data-comment-thread]").count(), 2);
    for (const paneWidth of [660, 420, 330]) {
      await page.setViewportSize({ width: Math.round(sideWidth + paneWidth + 1), height: 900 });
      await page.getByText("2 open comments").waitFor();
      await assertSelectionFitsColumn(paneWidth, "Beta");
      await snapshot(page, `${platform.id}-9g-2-comments-${paneWidth}`, ".untitled-document");
    }

    await page.setViewportSize({ width: Math.round(sideWidth + 660 + 1), height: 900 });
    await page.locator(".cm-commentHighlight").first().click();
    await page.getByRole("dialog", { name: "Comment thread" }).waitFor();
    await snapshot(page, `${platform.id}-9g-thread`, ".untitled-document");
    await page.keyboard.press("Escape");
    await selectAlpha();
    await page.getByRole("button", { name: "Comment", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => getSelection()?.toString()), "Alpha");
    await page.evaluate(() => { window.__pathlessCaptureEditor = document.querySelector(".cm-editor"); });
    const destination = join(root, "adopted.md");
    await page.evaluate((path) => window.__EMEND_E2E__?.setNextSaveAsDialogResult(path), destination);
    await page.getByRole("button", { name: "Save As…" }).click();
    await page.getByRole("tab", { name: "adopted.md" }).waitFor();
    assert.equal(await page.evaluate(() => window.__pathlessCaptureEditor === document.querySelector(".cm-editor")), true);
    await editor.focus();
    assert.equal(await page.evaluate(() => getSelection()?.toString()), "Alpha");
    assert.equal(await page.locator(".cm-commentHighlight").count(), 2);
    await page.getByText("2 open comments").waitFor();
    await snapshot(page, `${platform.id}-9g-adopted`, ".editor-shell");
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureToolbarWidths(page, platform, state, sideWidth) {
  const toolbar = page.getByRole("toolbar", { name: "Editor view controls" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => !document.querySelector(
    '.view-mode-toolbar .view-mode-toolbar__format-option[aria-busy="true"]',
  ));
  for (const paneWidth of [792, 660, 420, 330]) {
    await page.setViewportSize({ width: Math.round(sideWidth + paneWidth + 1), height: 900 });
    await page.waitForFunction(() => {
      const row = document.querySelector(".view-mode-toolbar");
      return row && row.scrollWidth <= row.clientWidth;
    });
    const frame = await toolbar.evaluate((row) => {
      const visible = (element) => getComputedStyle(element).visibility === "visible"
        && getComputedStyle(element).display !== "none";
      return {
        width: row.getBoundingClientRect().width,
        wrap: getComputedStyle(row).flexWrap,
        inlineFormatCount: [...row.querySelectorAll(".view-mode-toolbar__format-option")]
          .filter(visible).length,
        reviewPresent: !!row.querySelector('[role="group"][aria-label="Review changes"]'),
        overflowVisible: [...row.querySelectorAll('button[aria-label="More editor controls"]')]
          .some(visible),
      };
    });
    assert.equal(frame.wrap, "nowrap", `${state} toolbar must stay one row`);
    assert.ok(Math.abs(frame.width - paneWidth) <= 2, `${state} pane width ${paneWidth}, measured toolbar ${frame.width}`);
    assert.ok([0, 4].includes(frame.inlineFormatCount), `${state} format group split at ${paneWidth}`);
    assert.equal(frame.reviewPresent, state === "redline", `${state} review-group composition`);
    if (frame.inlineFormatCount === 0) assert.equal(frame.overflowVisible, true);
    await snapshot(page, `${platform.id}-3d-${state}-${paneWidth}`, ".view-mode-toolbar");
  }
  return toolbar;
}

async function captureToolbar(browser, viteUrl, driverUrl, platform) {
  const plain = "# Toolbar measure\n\nword\n";
  const marked = "# Toolbar measure\n\n{++pending++}\n\nword";
  const root = fixture(`${platform.id}-3d-toolbar`, plain);
  await post(driverUrl, "close_project");
  const { context, page } = await newPage(browser, viteUrl, platform);
  try {
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.locator(".cm-content:visible").waitFor();
    const sideWidth = await page.evaluate(() =>
      document.querySelector(".project-rail").getBoundingClientRect().width
      + document.querySelector(".timeline-panel").getBoundingClientRect().width);
    assert.equal(await page.getByRole("group", { name: "Review changes" }).count(), 0);
    await captureToolbarWidths(page, platform, "clean", sideWidth);

    await page.setViewportSize({ width: 1400, height: 900 });
    await page.getByRole("button", { name: "Close notes.md" }).click();
    writeFileSync(join(root, "notes.md"), marked);
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.getByRole("group", { name: "Review changes" }).waitFor();
    const toolbar = await captureToolbarWidths(page, platform, "redline", sideWidth);
    const more = toolbar.getByRole("button", { name: "More editor controls" });
    await more.focus();
    await page.keyboard.press("ArrowDown");
    const menu = toolbar.getByRole("dialog", { name: "More editor controls" });
    await menu.waitFor({ state: "visible" });
    assert.deepEqual(await menu.locator('[data-toolbar-control="format-group"] button').evaluateAll(
      (buttons) => buttons.map((button) => button.getAttribute("aria-label")),
    ), ["Bold", "Italic", "Heading 1", "Bulleted list"]);
    await snapshot(page, `${platform.id}-3d-redline-keyboard-menu-330`);
    await page.keyboard.press("Escape");
    assert.equal(await more.evaluate((button) => document.activeElement === button), true);
    await toolbar.getByRole("button", { name: "Markdown" }).click();
    const editor = page.locator(".cm-content");
    await editor.locator(".cm-line").last().click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await more.focus();
    await page.keyboard.press("ArrowDown");
    await menu.getByRole("button", { name: "Bold" }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("**word**"));
    assert.equal(await menu.isVisible(), false, "moved Bold closes the menu");
    assert.equal(await more.evaluate((button) => document.activeElement === button), true,
      "moved Bold returns keyboard focus to More");
    await snapshot(page, `${platform.id}-3d-redline-moved-bold-executed-330`);
    await editor.locator(".cm-line").last().click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+End");
    await more.click();
    await menu.getByRole("button", { name: "Italic" }).click();
    await page.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("***word***"));
    assert.equal(await menu.isVisible(), false, "moved Italic closes the menu after pointer activation");
    await snapshot(page, `${platform.id}-3d-redline-moved-italic-executed-330`);
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
  const pathlessRoot = fixture(`${platform.id}-3d-pathless`);
  const pathless = "untitled:1:notes.md";
  mkdirSync(join(pathlessRoot, ".emend"), { recursive: true });
  writeFileSync(join(pathlessRoot, ".emend", "tab-session.json"), JSON.stringify({
    schema_version: 1,
    tabs: [{ path: pathless, unsaved_content: "Pathless toolbar draft.\n", recovered_from: "notes.md" }],
    active_path: pathless,
  }));
  const next = await newPage(browser, viteUrl, platform);
  try {
    await next.page.evaluate((value) => window.__EMEND_E2E__?.openProject(value.root, value.path), {
      root: pathlessRoot, path: pathless,
    });
    await next.page.locator(".untitled-document .view-mode-toolbar").waitFor();
    const sideWidth = await next.page.evaluate(() =>
      document.querySelector(".project-rail").getBoundingClientRect().width
      + document.querySelector(".timeline-panel").getBoundingClientRect().width);
    await captureToolbarWidths(next.page, platform, "pathless", sideWidth);
  } finally {
    await next.context.close();
    await post(driverUrl, "close_project");
  }
}

// The D23 driver has no linked voice owner. This capture-only transport supplies the typed
// owner status and ordered events at that absent boundary; React, CM6 and CSS stay mounted.
async function installVoiceCaptureFixture(page, driverUrl) {
  const base = {
    enabled: true, selected_device_id: "fixture-default",
    devices: [{ id: "fixture-default", name: "Visual fixture mic", is_default: true }],
    device_issue: null, model: "ready", download: { kind: "idle" }, download_revision: 0,
    capture_active: false, inference_available: true, dictation: { kind: "idle" },
    dictation_generation: null,
  };
  let status = base;
  let generation = 0;
  const events = [];
  await page.route(`${driverUrl}/get_voice_status`, (route) => route.fulfill({ json: status }));
  await page.route(`${driverUrl}/start_voice_dictation`, (route) => {
    generation += 1;
    status = { ...status, capture_active: true,
      dictation: { kind: "recording", elapsed_seconds: 7 }, dictation_generation: generation };
    return route.fulfill({ json: { ...status, accepted_generation: generation } });
  });
  await page.route(`${driverUrl}/cancel_voice_dictation`, (route) => {
    status = { ...status, capture_active: false, dictation: { kind: "idle" }, dictation_generation: null };
    return route.fulfill({ json: status });
  });
  await page.route(`${driverUrl}/events`, async (route) => {
    const response = await route.fetch();
    const batch = await response.json();
    if (events.length) {
      batch.events.push(...events.splice(0).map((payload) => ({
        cursor: batch.cursor, event: "voice://dictation", payload,
      })));
    }
    await route.fulfill({ response, json: batch });
  });
  return {
    setStatus: async (change) => {
      status = { ...status, ...change };
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    },
    emit: (kind, text) => events.push({ kind, generation, ...(text ? { text } : {}) }),
    emitFailed: (reason) => events.push({ kind: "failed", generation, reason }),
  };
}

async function captureVoiceModelSettings(browser, viteUrl, driverUrl, platform, theme) {
  evidence.colorScheme = "mixed";
  evidence.fixture = { kind: "typed test-only voice status transport over D23",
    boundary: "get_voice_status",
    limits: "Browser Settings styling only; no physical microphone, network download or native Windows controls" };
  const root = fixture(`${platform.id}-14b-model-${theme}`);
  await post(driverUrl, "close_project");
  let status = {
    enabled: true, selected_device_id: "fixture-mic", selected_device_name: "Visual fixture microphone",
    devices: [{ id: "fixture-mic", name: "Visual fixture microphone", is_default: true }],
    device_issue: null, model: "absent", model_origin: null, external_model_path: null,
    download: { kind: "idle" }, download_revision: 0,
    capture_active: false, inference_available: true, dictation: { kind: "idle" },
    dictation_generation: null,
  };
  const { context, page } = await newPage(browser, viteUrl, platform, 1400, 900,
    async (tab) => tab.route(`${driverUrl}/get_voice_status`, (route) => route.fulfill({ json: status })), theme);
  const capture = async (state, changes, width = 1400) => {
    status = { ...status, ...changes };
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("button", { name: "Refresh voice status" }).click();
    const expectedAction = state === "progress" ? "Cancel download"
      : state === "cancelling" ? "Cancelling…"
      : state === "cancelled" ? "Resume model download"
      : state === "failed" || state === "narrow-failed" ? "Retry model download"
      : "Stop using this file";
    await page.getByRole("button", { name: expectedAction }).waitFor();
    await page.locator(".settings-dialog__model-row").scrollIntoViewIfNeeded();
    if (state === "failed" || state === "narrow-failed") {
      await page.locator(".settings-dialog__model-error").scrollIntoViewIfNeeded();
    }
    if (state === "external" || state === "narrow-external") {
      await page.locator(".settings-dialog__model-path").scrollIntoViewIfNeeded();
    }
    await page.evaluate(() => document.fonts.ready);
    const modelVisual = await page.locator(".settings-dialog").evaluate((dialog) => {
      const row = dialog.querySelector(".settings-dialog__model-row");
      const state = row.querySelector(".settings-dialog__model-state > span");
      const action = row.querySelector(".settings-dialog__model-action");
      const bar = row.querySelector(".settings-dialog__model-progress");
      const fill = bar?.querySelector("span");
      const path = dialog.querySelector(".settings-dialog__model-path");
      const note = dialog.querySelector(".settings-dialog__model-note");
      const alert = dialog.querySelector(".settings-dialog__model-error");
      const rowRect = row.getBoundingClientRect();
      const actionRect = action.getBoundingClientRect();
      const dialogRect = dialog.getBoundingClientRect();
      const contentRect = dialog.querySelector(".settings-dialog__content").getBoundingClientRect();
      const barRect = bar?.getBoundingClientRect();
      const fillRect = fill?.getBoundingClientRect();
      const visibleInContent = (element) => {
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        return rect.top >= contentRect.top - 1 && rect.bottom <= contentRect.bottom + 1;
      };
      return {
        theme: document.documentElement.dataset.theme,
        status: state.textContent.trim(),
        action: action.textContent.trim(),
        actionDisabled: action.disabled,
        actionBusy: action.getAttribute("aria-busy"),
        actionVisible: actionRect.width > 0 && actionRect.right <= dialogRect.right + 1 &&
          actionRect.top >= dialogRect.top && actionRect.bottom <= dialogRect.bottom + 1,
        rowFits: row.scrollWidth <= row.clientWidth + 1 && actionRect.right <= rowRect.right + 1,
        bar: bar && { width: barRect.width, height: barRect.height,
          fillWidth: fillRect.width, fill: getComputedStyle(fill).backgroundColor,
          track: getComputedStyle(bar).backgroundColor },
        alert: alert?.textContent.trim() ?? null,
        alertVisible: visibleInContent(alert),
        alertWidth: alert?.getBoundingClientRect().width ?? null,
        alertColor: alert && getComputedStyle(alert).color,
        note: note?.textContent.trim() ?? null,
        pathEllipsized: path ? path.scrollWidth > path.clientWidth && getComputedStyle(path).textOverflow === "ellipsis" : null,
        pathVisible: visibleInContent(path),
      };
    });
    await snapshot(page, `${platform.id}-14b-model-${theme}-${state}`, ".settings-dialog", { modelVisual });
  };
  try {
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.locator(".cm-content:visible").waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("dialog", { name: "Settings" }).waitFor();
    await capture("progress", { download: { kind: "progress", downloaded: 42, total: 100 }, download_revision: 1 });
    await capture("cancelling", { download: { kind: "cancelling" }, download_revision: 2 });
    await capture("cancelled", { download: { kind: "cancelled", downloaded: 42, total: 100 }, download_revision: 3 });
    await capture("failed", { download: { kind: "failed", reason: "transport" }, download_revision: 4 });
    const external = { model: "ready", model_origin: "external",
      external_model_path: "/Users/writer/Very-long-project-name/Models/CoWrite/voice-model-file-with-long-name.bin",
      download: { kind: "idle" }, download_revision: 5 };
    await capture("external", external);
    await capture("narrow-external", external, 520);
    await capture("narrow-failed", { model: "absent", model_origin: null, external_model_path: null,
      download: { kind: "failed", reason: "transport" }, download_revision: 6 }, 520);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function voiceSnapshot(page, platform, state, micSelector, target = null) {
  const mic = page.locator(micSelector).first();
  await mic.waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  const voice = await page.evaluate((selector) => {
    const mic = document.querySelector(selector);
    const toolbar = document.querySelector(".view-mode-toolbar");
    const more = toolbar?.querySelector('button[aria-label="More editor controls"]');
    const micBox = mic.getBoundingClientRect();
    const rowBox = toolbar?.getBoundingClientRect();
    const timelineBox = toolbar?.querySelector(".timeline-host__collapsed-action")?.getBoundingClientRect();
    const timelineAction = toolbar?.querySelector(".timeline-host__collapsed-action");
    const input = document.querySelector(".message-input__field-wrap");
    const composer = mic.closest(".message-input, .comment-composer");
    const mutable = document.querySelector(".tabbed-editor__mutable-surface");
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      micWidth: micBox.width, micHeight: micBox.height, micLabel: mic.getAttribute("aria-label"),
      micDisabled: mic.disabled,
      micOpacity: getComputedStyle(mic).opacity,
      toolbarWidth: rowBox?.width, toolbarHeight: rowBox?.height,
      projectRailWidth: document.querySelector(".project-rail")?.getBoundingClientRect().width ?? null,
      commentsWidth: document.querySelector(".comments-column")?.getBoundingClientRect().width ?? null,
      toolbarWrap: toolbar && getComputedStyle(toolbar).flexWrap,
      micInsideToolbar: Boolean(rowBox && micBox.left >= rowBox.left && micBox.right <= rowBox.right &&
        micBox.top >= rowBox.top && micBox.bottom <= rowBox.bottom),
      timelineWidth: timelineBox?.width ?? null,
      timelineLabel: timelineAction?.getAttribute("aria-label") ?? null,
      permissionBadgeVisible: Boolean(timelineAction?.querySelector(".timeline-host__permission-badge")),
      editorViewOverflowed: toolbar?.querySelector('[data-toolbar-control="editor-view"]')?.getAttribute("data-overflowed") === "true",
      mutableInert: mutable?.hasAttribute("inert") ?? false,
      mutableOpacity: mutable && getComputedStyle(mutable).opacity,
      micInOverflow: Boolean(mic.closest('[aria-label="More editor controls"]')),
      overflowVisible: Boolean(more && getComputedStyle(more).display !== "none" &&
        getComputedStyle(more).visibility !== "hidden"),
      ghostText: document.querySelector(".cm-dictation-ghost")?.textContent ?? null,
      partialText: composer?.querySelector(".composer-dictation-partial")?.textContent ?? null,
      micInsideInput: Boolean(input?.contains(mic)),
    };
  }, micSelector);
  assert.equal(voice.micWidth, 28);
  assert.equal(voice.micHeight, 26);
  if (state === "narrow-330") {
    assert.ok(Math.abs(voice.toolbarWidth - 330) <= 2);
    assert.equal(voice.toolbarWrap, "nowrap");
    assert.equal(voice.micInOverflow, false);
    assert.equal(voice.overflowVisible, true);
  }
  await snapshot(page, `${platform.id}-voice-${state}`, target, { voice });
}

async function captureEditorGhost(browser, viteUrl, driverUrl, platform, theme) {
  evidence.colorScheme = "mixed";
  evidence.fixture = { kind: "typed test-only voice transport over D23",
    boundary: "get_voice_status/start_voice_dictation/cancel_voice_dictation/voice://dictation",
    limits: "Browser platform styling; no physical microphone, native Windows window or real Whisper inference" };
  const text = "The second example carries the argument; the first only sets it up — a reader rarely needs both.\n";
  const partial = "the first only sets it up, and a reader who has seen the second has already understood the first, so the paragraph can lose it without losing anything it needs; the following sentence explains the same point again for a narrower audience";
  const root = fixture(`${platform.id}-14d-editor-ghost-${theme}`, text);
  await post(driverUrl, "close_project");
  const { context, page, setup: owner } = await newPage(browser, viteUrl, platform, 1400, 900,
    (tab) => installVoiceCaptureFixture(tab, driverUrl), theme);
  const editorMic = ".view-mode-toolbar__dictation .dictation-mic";
  const placeCaret = async (position, length = 0) => {
    await page.locator(".cm-content:visible .cm-line").first().click();
    await page.keyboard.press(platform.id === "mac" ? "Meta+ArrowUp" : "Control+Home");
    for (let index = 0; index < position; index += 1) await page.keyboard.press("ArrowRight");
    if (length) {
      await page.keyboard.down("Shift");
      for (let index = 0; index < length; index += 1) await page.keyboard.press("ArrowRight");
      await page.keyboard.up("Shift");
    }
  };
  const capture = async (target) => {
    await page.locator(editorMic).click();
    await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-label") === "Stop dictation — recording", editorMic);
    owner.emit("partial", partial);
    await page.locator(".cm-dictation-ghost").getByText(partial).waitFor();
    if (target === "selected") {
      await page.locator(".cm-content:visible .cm-line").first().click({ position: { x: 3, y: 3 } });
    }
    const ghostVisual = await page.evaluate(() => {
      const ghost = document.querySelector(".cm-dictation-ghost");
      const held = document.querySelector(".cm-dictation-held-range");
      const ghostStyle = getComputedStyle(ghost);
      const heldStyle = held && getComputedStyle(held);
      return {
        theme: document.documentElement.dataset.theme,
        display: ghostStyle.display, whiteSpace: ghostStyle.whiteSpace,
        marginLeft: ghostStyle.marginLeft, underlineOffset: ghostStyle.textUnderlineOffset,
        lineBoxes: ghost.getClientRects().length,
        heldText: held?.textContent ?? null,
        heldBackground: heldStyle?.backgroundColor ?? null,
        heldBoxShadow: heldStyle?.boxShadow ?? null,
        ghostAfterHeld: Boolean(held && held.compareDocumentPosition(ghost) & Node.DOCUMENT_POSITION_FOLLOWING),
      };
    });
    await snapshot(page, `${platform.id}-14d-editor-ghost-${theme}-${target}`, ".editor-region", { ghostVisual });
    if (target === "collapsed") {
      const sideWidth = await page.evaluate(() => document.querySelector(".project-rail").getBoundingClientRect().width
        + document.querySelector(".timeline-panel").getBoundingClientRect().width);
      await page.setViewportSize({ width: Math.round(sideWidth + 331), height: 900 });
      await page.waitForFunction(() => {
        const toolbar = document.querySelector(".view-mode-toolbar");
        return toolbar && toolbar.scrollWidth <= toolbar.clientWidth;
      });
      const compact = await page.evaluate((selector) => {
        const toolbar = document.querySelector(".view-mode-toolbar");
        const mic = document.querySelector(selector);
        const more = toolbar.querySelector('button[aria-label="More editor controls"]');
        const toolbarBox = toolbar.getBoundingClientRect();
        const micBox = mic.getBoundingClientRect();
        return {
          theme: document.documentElement.dataset.theme,
          toolbarWidth: toolbarBox.width, toolbarWrap: getComputedStyle(toolbar).flexWrap,
          micWidth: micBox.width, micHeight: micBox.height,
          micInsideToolbar: micBox.left >= toolbarBox.left && micBox.right <= toolbarBox.right
            && micBox.top >= toolbarBox.top && micBox.bottom <= toolbarBox.bottom,
          overflowVisible: Boolean(more && getComputedStyle(more).display !== "none"
            && getComputedStyle(more).visibility !== "hidden"),
        };
      }, editorMic);
      await snapshot(page, `${platform.id}-14d-editor-ghost-${theme}-compact`, ".editor-region", { compact });
      await page.setViewportSize({ width: 1400, height: 900 });
    }
    owner.emit("cancelled");
    await page.locator(".cm-dictation-ghost").waitFor({ state: "detached" });
    await owner.setStatus({ capture_active: false, dictation: { kind: "idle" }, dictation_generation: null });
    await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-label") === "Dictate", editorMic);
  };
  try {
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.locator(".cm-content:visible").waitFor();
    await placeCaret(40);
    await capture("collapsed");
    await placeCaret(41, 25);
    await capture("selected");
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureDarkMic(browser, viteUrl, driverUrl, platform) {
  evidence.colorScheme = "dark";
  evidence.fixture = { kind: "typed test-only voice transport over D23",
    boundary: "get_voice_status/start_voice_dictation/cancel_voice_dictation/voice://dictation",
    limits: "Browser platform styling; no physical microphone, native Windows window or real Whisper inference" };
  const root = fixture(`${platform.id}-dark-voice`, "# Voice palette\n\nA sentence for dictation.\n");
  await post(driverUrl, "close_project");
  const { context, page, setup: owner } = await newPage(browser, viteUrl, platform, 1400, 900,
    (tab) => installVoiceCaptureFixture(tab, driverUrl), "dark");
  const surfaces = [
    ["editor", ".view-mode-toolbar__dictation .dictation-mic", ".view-mode-toolbar"],
    ["timeline", ".message-input .dictation-mic", ".message-composer"],
    ["comment", ".comment-composer .dictation-mic", ".comment-popover"],
  ];
  try {
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.locator(".cm-content:visible").waitFor();
    await page.locator(".cm-content:visible").click();
    await page.keyboard.press(platform.id === "mac" ? "Meta+Home" : "Control+Home");
    for (let index = 0; index < 5; index += 1) await page.keyboard.press("Shift+ArrowRight");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await page.getByRole("dialog", { name: "New comment" }).waitFor();
    const states = [
      ["idle", {}],
      ["downloading", { model: "absent", download: { kind: "progress", downloaded: 42, total: 100 }, download_revision: 1 }],
      ["cancelling", { download: { kind: "cancelling" }, download_revision: 2 }],
      ["download_cancelled", { download: { kind: "cancelled" }, download_revision: 3 }],
      ["error", { model: "ready", download: { kind: "idle" }, download_revision: 4, device_issue: "no_device" }],
      ["recording", { device_issue: null, capture_active: true, dictation: { kind: "recording", elapsed_seconds: 7 } }],
      ["transcribing", { capture_active: false, dictation: { kind: "transcribing" } }],
    ];
    for (const [state, status] of states) {
      await owner.setStatus(status);
      await page.waitForFunction((kind) =>
        [".view-mode-toolbar__dictation", ".message-input", ".comment-composer"].every((surface) =>
          document.querySelector(`${surface} .dictation-mic`)?.classList.contains(`dictation-mic--${kind}`)), state);
      for (const [surface, selector, target] of surfaces) {
        const mic = page.locator(selector);
        if (state === "idle") {
          await page.keyboard.press("Tab");
          await mic.focus();
          await page.waitForFunction((name) => document.querySelector(name)?.matches(":focus-visible"), selector);
        }
        const micStyle = await mic.evaluate((button) => {
          const style = getComputedStyle(button);
          const child = button.querySelector(".dictation-mic__dots i, .dictation-mic__glyph rect");
          const progress = button.querySelector(".dictation-mic__progress");
          const fill = progress?.querySelector("span");
          return {
            theme: document.documentElement.getAttribute("data-theme"),
            width: button.getBoundingClientRect().width,
            height: button.getBoundingClientRect().height,
            background: style.backgroundColor,
            color: style.color,
            border: style.borderColor,
            boxShadow: style.boxShadow,
            outlineColor: style.outlineColor,
            outlineWidth: style.outlineWidth,
            childFill: child && getComputedStyle(child).fill,
            childBackground: child && getComputedStyle(child).backgroundColor,
            trackBackground: progress && getComputedStyle(progress).backgroundColor,
            progressBackground: fill && getComputedStyle(fill).backgroundColor,
          };
        });
        await snapshot(page, `${platform.id}-dark-voice-${surface}-${state}`, target, { micStyle });
      }
    }
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureComposerVoiceError(browser, viteUrl, driverUrl, platform) {
  evidence.colorScheme = "mixed";
  evidence.fixture = { kind: "typed test-only voice transport over D23",
    boundary: "get_voice_status/start_voice_dictation/voice://dictation",
    limits: "Browser geometry and styling, not physical microphone capture or Whisper inference" };
  for (const theme of ["light", "dark"]) {
    for (const surface of ["timeline", "comment"]) {
      const root = fixture(`${platform.id}-${theme}-${surface}-voice-error`, "# Voice error\n\nA sentence to annotate.\n");
      await post(driverUrl, "close_project");
      const { context, page, setup: owner } = await newPage(browser, viteUrl, platform, 1400, 900,
        (tab) => installVoiceCaptureFixture(tab, driverUrl), theme);
      try {
        await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
        await page.locator(".cm-content:visible").waitFor();
        if (surface === "comment") {
          await page.locator(".cm-content:visible").click();
          await page.keyboard.press(platform.id === "mac" ? "Meta+Home" : "Control+Home");
          for (let index = 0; index < 5; index += 1) await page.keyboard.press("Shift+ArrowRight");
          await page.getByRole("button", { name: "Comment", exact: true }).click();
          await page.getByRole("dialog", { name: "New comment" }).waitFor();
        }
        const form = page.locator(surface === "timeline" ? ".message-input" : ".comment-composer");
        const slot = form.locator(".composer-dictation-partial");
        const input = form.locator(surface === "timeline" ? ".message-input__field" : ".comment-composer__body");
        await input.fill(surface === "timeline" ? "Keep this message" : "Keep this comment");
        await form.locator(".dictation-mic").click();
        await form.getByRole("button", { name: "Stop dictation — recording" }).waitFor();
        const record = async (phase) => {
          await page.evaluate(() => document.fonts.ready);
          const echo = await slot.evaluate((element) => {
            const form = element.closest(".message-input, .comment-composer");
            const input = form.querySelector(".message-input__field, .comment-composer__body");
            const action = form.querySelector(".message-input__send, .comment-composer__submit");
            const box = (node) => {
              const rect = node.getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right };
            };
            const style = getComputedStyle(element);
            return {
              text: element.textContent.trim(), draft: input.value,
              provisional: element.dataset.provisional, error: element.dataset.error,
              color: style.color, fontSize: style.fontSize, textDecoration: style.textDecorationLine,
              lineHeight: style.lineHeight, ariaLive: element.getAttribute("aria-live"),
              slot: box(element), input: box(input), action: box(action),
            };
          });
          await snapshot(page, `${platform.id}-${theme}-voice-${surface}-${phase}`,
            surface === "timeline" ? ".message-composer" : ".comment-popover", { theme, surface, phase, echo });
        };
        owner.emit("partial", "A provisional sentence that wraps across the composer so its second line remains inside the same input column.");
        await slot.getByText(/A provisional sentence/).waitFor();
        await record("partial-wrap");
        owner.emitFailed(surface === "timeline" ? "inference_failed" : "invalid_audio");
        await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("data-error") === "true",
          surface === "timeline" ? ".message-input .composer-dictation-partial" : ".comment-composer .composer-dictation-partial");
        await record("error");
      } finally {
        await page.unrouteAll({ behavior: "ignoreErrors" });
        await context.close();
        await post(driverUrl, "close_project");
      }
    }
  }
}

async function captureVoice(browser, viteUrl, driverUrl, platform, theme = "light", frozenOnly = false) {
  evidence.colorScheme = theme;
  evidence.fixture = { kind: "typed test-only voice transport over D23",
    boundary: "get_voice_status/start_voice_dictation/cancel_voice_dictation/voice://dictation",
    limits: "Browser platform styling; no physical microphone, native Windows window or real Whisper inference" };
  const root = fixture(`${platform.id}-voice`, "# Voice layout\n\nA pending revision.\n\nA sentence for dictation.\n");
  const documentPath = frozenOnly ? "untitled:1:product-brief.md" : "notes.md";
  if (frozenOnly) {
    mkdirSync(join(root, ".emend"), { recursive: true });
    writeFileSync(join(root, ".emend", "tab-session.json"), JSON.stringify({
      schema_version: 1,
      tabs: [{ path: documentPath, unsaved_content: "Rewriting the positioning section from memory.",
        recovered_from: "product-brief.md" }],
      active_path: documentPath,
    }));
  }
  await post(driverUrl, "close_project");
  const { context, page, setup: owner } = await newPage(browser, viteUrl, platform, 1400, 900,
    (tab) => installVoiceCaptureFixture(tab, driverUrl), theme);
  let releaseProof = () => {};
  try {
    await page.evaluate(({ projectRoot, path }) => window.__EMEND_E2E__?.openProject(projectRoot, path),
      { projectRoot: root, path: documentPath });
    await page.locator(".cm-content:visible").waitFor();
    if (frozenOnly) {
      await page.getByRole("button", { name: "Hide Timeline" }).click();
      await page.getByRole("button", { name: "Show Timeline" }).waitFor();
    }
    const editorMic = ".view-mode-toolbar__dictation .dictation-mic";
    await page.locator(editorMic).waitFor();
    await page.locator(editorMic).getAttribute("aria-label");
    await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-label") === "Dictate", editorMic);
    if (!frozenOnly) {
      await voiceSnapshot(page, platform, "editor-idle", editorMic, ".editor-region");
      await voiceSnapshot(page, platform, "timeline-composer", ".message-input .dictation-mic", ".message-composer");

      await owner.setStatus({ model: "absent", download: { kind: "progress", downloaded: 42, total: 100 }, download_revision: 1 });
      await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-label")?.includes("42%"), editorMic);
      await voiceSnapshot(page, platform, "editor-downloading", editorMic, ".editor-region");

      await owner.setStatus({ model: "ready", download: { kind: "idle" }, download_revision: 2,
        device_issue: "no_device" });
      await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-label") === "Dictate — no microphone found", editorMic);
      await voiceSnapshot(page, platform, "editor-error", editorMic, ".editor-region");

      await owner.setStatus({ device_issue: "permission_denied" });
      await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-label") === "Dictate — microphone permission denied", editorMic);
      await voiceSnapshot(page, platform, "editor-error-permission", editorMic, ".editor-region");

      await owner.setStatus({ device_issue: null, model: "missing" });
      await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-label") === "Dictate — voice model missing", editorMic);
      await voiceSnapshot(page, platform, "editor-error-model", editorMic, ".editor-region");

      await owner.setStatus({ model: "ready" });
      await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-label") === "Dictate", editorMic);
      await page.locator(".cm-content:visible .cm-line").last().click();
      await page.locator(editorMic).click();
      await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-label") === "Stop dictation — recording", editorMic);
      owner.emit("partial", "a provisional sentence");
      await page.locator(".cm-dictation-ghost").getByText("a provisional sentence").waitFor();
      await voiceSnapshot(page, platform, "editor-recording-partial", editorMic, ".editor-region");
      const sideWidth = await page.evaluate(() => document.querySelector(".project-rail").getBoundingClientRect().width
        + document.querySelector(".timeline-panel").getBoundingClientRect().width);
      await page.setViewportSize({ width: Math.round(sideWidth + 331), height: 900 });
      await page.waitForFunction(() => {
        const row = document.querySelector(".view-mode-toolbar");
        return row && row.scrollWidth <= row.clientWidth;
      });
      await voiceSnapshot(page, platform, "narrow-330", editorMic, ".view-mode-toolbar");
      await page.setViewportSize({ width: 1400, height: 900 });

      await owner.setStatus({ capture_active: false, dictation: { kind: "transcribing" } });
      await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-label") === "Dictation — transcribing", editorMic);
      await voiceSnapshot(page, platform, "editor-transcribing", editorMic, ".editor-region");
      owner.emit("cancelled");
      await page.locator(".cm-dictation-ghost").waitFor({ state: "detached" });
      await owner.setStatus({ dictation: { kind: "idle" }, dictation_generation: null });
      await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-label") === "Dictate", editorMic);

      await page.locator(".message-input .dictation-mic").click();
      await page.waitForFunction(() => document.querySelector(".message-input .dictation-mic")?.getAttribute("aria-label") === "Stop dictation — recording");
      owner.emit("partial", "spoken chat draft");
      await page.locator(".message-input .composer-dictation-partial").getByText("spoken chat draft").waitFor();
      await voiceSnapshot(page, platform, "timeline-recording-partial", ".message-input .dictation-mic", ".message-composer");
      owner.emit("cancelled");
      await page.waitForFunction(() => document.querySelector(".message-input .composer-dictation-partial")?.getAttribute("data-provisional") === "false");
      await owner.setStatus({ capture_active: false, dictation: { kind: "idle" }, dictation_generation: null });
      await page.waitForFunction(() => document.querySelector(".message-input .dictation-mic")?.getAttribute("aria-label") === "Dictate");

      await page.locator(".cm-content:visible").click();
      await page.keyboard.press(platform.id === "mac" ? "Meta+Home" : "Control+Home");
      for (let index = 0; index < 5; index += 1) await page.keyboard.press("Shift+ArrowRight");
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      const comment = page.getByRole("dialog", { name: "New comment" });
      await comment.waitFor();
      await comment.locator(".dictation-mic").click();
      await page.waitForFunction(() => document.querySelector(".comment-composer .dictation-mic")?.getAttribute("aria-label") === "Stop dictation — recording");
      owner.emit("partial", "spoken comment draft");
      await comment.locator(".composer-dictation-partial").getByText("spoken comment draft").waitFor();
      await voiceSnapshot(page, platform, "comment-composer", ".comment-composer .dictation-mic", ".comment-popover");
      owner.emit("cancelled");
      await page.waitForFunction(() => document.querySelector(".comment-composer .composer-dictation-partial")?.getAttribute("data-provisional") === "false");
      await comment.getByRole("button", { name: "Cancel" }).click();
    }

    await owner.setStatus({ model: "ready", device_issue: null, capture_active: false,
      dictation: { kind: "idle" }, dictation_generation: null });
    await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-label") === "Dictate", editorMic);
    await page.locator(".cm-content:visible .cm-line").last().click();
    await page.locator(editorMic).click();
    await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-label") === "Stop dictation — recording", editorMic);
    owner.emit("partial", "speech before close proof");
    await page.locator(".cm-dictation-ghost").getByText("speech before close proof").waitFor();
    const proofUrl = `${driverUrl}/prove_tab_session`;
    const saveUrl = `${driverUrl}/save_tab_session`;
    const proofReleased = new Promise((resolve) => { releaseProof = resolve; });
    await page.route(proofUrl, async (route) => {
      await proofReleased;
      await route.continue();
    });
    await page.route(saveUrl, async (route) => {
      if (route.request().postDataJSON()?.policy !== "require_untitled_lossless") {
        await route.continue();
        return;
      }
      await proofReleased;
      await route.continue();
    });
    const proofRequested = page.waitForRequest((request) =>
      request.url() === proofUrl || (request.url() === saveUrl && request.postDataJSON()?.policy === "require_untitled_lossless"),
    { timeout: 10_000 });
    await page.evaluate(() => window.__EMEND_E2E__?.requestCoordinatedClose());
    if (frozenOnly) {
      const guard = page.getByRole("alertdialog", { name: /Unsaved work in Untitled/ });
      await guard.getByRole("button", { name: "Discard this untitled document" }).click();
    }
    const terminalRequest = await proofRequested;
    await page.locator('.tabbed-editor__mutable-surface[inert][aria-busy="true"]').waitFor();
    await page.waitForFunction((selector) =>
      document.querySelector(selector)?.getAttribute("aria-label") === "Dictate — unavailable while saving"
      && !document.querySelector(".cm-dictation-ghost"), editorMic);
    if (theme === "dark") await page.locator(".tabbed-editor__session-status").waitFor();
    const frozenName = theme === "dark" ? "dark-editor-frozen" : "editor-frozen";
    await voiceSnapshot(page, platform, frozenName, editorMic, theme === "dark" ? null : ".editor-region");
    evidence.captures[`${platform.id}-voice-${frozenName}`].voice.sessionOperation = terminalRequest.url().slice(driverUrl.length + 1);
    releaseProof();
    await page.unroute(proofUrl);
    await page.unroute(saveUrl);
  } finally {
    releaseProof();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureCompactToolbar900(browser, viteUrl, driverUrl, platform, theme = "light") {
  evidence.colorScheme = theme;
  evidence.fixture = { kind: "typed test-only voice transport over D23",
    boundary: "get_voice_status/start_voice_dictation/cancel_voice_dictation/voice://dictation",
    limits: "Browser platform styling; no physical microphone, native Windows window or real Whisper inference" };
  const root = fixture(`${platform.id}-compact-toolbar-900`, "# Compact toolbar\n\nThe pinned mic stays visible.\n");
  await post(driverUrl, "close_project");
  const { context, page } = await newPage(browser, viteUrl, platform, 1400, 900,
    (tab) => installVoiceCaptureFixture(tab, driverUrl), theme);
  try {
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    const editorMic = ".view-mode-toolbar__dictation .dictation-mic";
    await page.locator(".cm-content:visible .cm-line").last().click();
    await page.waitForFunction((selector) => document.querySelector(selector)?.getAttribute("aria-label") === "Dictate", editorMic);
    await page.getByRole("button", { name: "Hide Timeline" }).click();
    await page.setViewportSize({ width: 900, height: 900 });
    await page.waitForFunction(() => {
      const row = document.querySelector(".view-mode-toolbar");
      return Math.abs((row?.getBoundingClientRect().width ?? 0) - 263) <= 1 &&
        row?.querySelector('[data-toolbar-control="editor-view"]')?.getAttribute("data-overflowed") === "true";
    });
    const state = (name) => `compact-900-${theme === "dark" ? "dark-" : ""}${name}`;
    await voiceSnapshot(page, platform, state("idle"), editorMic, ".view-mode-toolbar");
    const more = page.getByRole("button", { name: "More editor controls" });
    await more.focus();
    await more.press("ArrowDown");
    await page.getByRole("dialog", { name: "More editor controls" }).getByRole("button", { name: "Rich text" }).waitFor();
    await voiceSnapshot(page, platform, state("menu"), editorMic);
    if (theme === "dark") {
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Show Timeline" }).click();
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.getByRole("textbox", { name: "Message", exact: true }).fill("permission fixture allow");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByRole("button", { name: "Allow once", exact: true }).waitFor();
      await page.getByRole("button", { name: "Hide Timeline" }).click();
      await page.setViewportSize({ width: 900, height: 900 });
      await page.getByRole("button", { name: "Show permission request in Timeline" }).waitFor();
      await page.waitForFunction(() =>
        document.querySelector('.view-mode-toolbar [data-toolbar-control="editor-view"]')?.getAttribute("data-overflowed") === "true");
      await voiceSnapshot(page, platform, state("pending"), editorMic, ".view-mode-toolbar");
      await more.focus();
      await more.press("ArrowDown");
      await page.getByRole("dialog", { name: "More editor controls" }).getByRole("button", { name: "Rich text" }).waitFor();
      await voiceSnapshot(page, platform, state("pending-menu"), editorMic);
    }
  } finally {
    if (theme === "dark") {
      const run = await post(driverUrl, "run_state").catch(() => null);
      if (run?.active?.id) {
        await post(driverUrl, "stop_run", { runId: run.active.id });
        await page.waitForFunction(async (url) => {
          const response = await fetch(`${url}/run_state`, {
            method: "POST", headers: { "content-type": "application/json" }, body: "{}",
          });
          return response.ok && (await response.json()).active === null;
        }, driverUrl, { timeout: 10_000 });
      }
    }
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureAddressChooser(browser, viteUrl, driverUrl, platform, theme) {
  evidence.colorScheme = "mixed";
  const content = "# Address chooser\n\nTwo passages need review before publication.\n";
  const root = fixture(`${platform.id}-15-chooser-${theme}`, content);
  for (const [index, phrase] of ["Two passages", "before publication"].entries()) {
    await post(driverUrl, "create_comment", {
      root, path: "notes.md", author: "reviewer", body: `Review ${index + 1}`,
      anchor: { content, utf16Offset: content.indexOf(phrase), utf16Length: phrase.length },
      timestamp: Date.now() - 60_000 + index,
    });
  }
  await post(driverUrl, "close_project");
  const { context, page } = await newPage(browser, viteUrl, platform, 1280, 900, null, theme);
  try {
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.getByRole("button", { name: "Hide Timeline" }).click();
    await page.evaluate(async () => {
      const faces = [...document.fonts].filter((face) => /IBM Plex Sans/.test(face.family));
      await Promise.all(faces.map((face) => face.load()));
    });
    for (const width of [1280, 900]) {
      await page.setViewportSize({ width, height: 900 });
      const more = page.getByRole("button", { name: "More editor controls" });
      if (width === 900) {
        await page.waitForFunction(() => document.querySelector('[data-toolbar-control="comment-address-all"]')
          ?.getAttribute("data-overflowed") === "true");
        await more.click();
      }
      await page.getByRole("button", { name: /Address all/ }).click();
      const panel = page.getByRole("dialog", { name: "Address comments" });
      await panel.waitFor();
      if (width === 900) await page.waitForFunction(() => document.querySelector('.view-mode-toolbar__overflow-trigger')
        ?.getAttribute("data-chooser-open") === "true");
      const chooser = await measureAddressChooser(page, width);
      assert.equal(chooser.toolbarRows, 1);
      assert.equal(chooser.panelTop - chooser.invokerBottom, 4);
      assert.ok(Math.abs(chooser.panelRight - chooser.invokerRight) <= 1);
      await snapshot(page, `${platform.id}-15-chooser-${theme}-${width}`, null, { chooser });
      await panel.getByLabel("Source").press("Escape");
    }
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function measureAddressChooser(page, width) {
  return page.evaluate((narrow) => {
        const toolbar = document.querySelector(".view-mode-toolbar");
        const panel = document.querySelector('.batch-address__panel--floating');
        const invoker = document.querySelector(narrow ? '.view-mode-toolbar__overflow-trigger' :
          '.view-mode-toolbar [data-toolbar-control="comment-address-all"] .batch-address__trigger');
        const mic = document.querySelector('.view-mode-toolbar__dictation .dictation-mic');
        if (!toolbar || !panel || !invoker || !mic) throw new Error("chooser capture lacks production controls");
        const scope = panel.querySelector('.batch-address__scope > span');
        const checkbox = panel.querySelector('.batch-address__include input');
        const select = panel.querySelector('.batch-address__filter select');
        const run = panel.querySelector('.batch-address__run');
        if (!scope || !select || !run) throw new Error("chooser capture lacks production fields");
        const row = toolbar.getBoundingClientRect();
        const box = panel.getBoundingClientRect();
        const anchor = invoker.getBoundingClientRect();
        return {
          toolbarRows: Math.round(row.height / (toolbar.dataset.platform === "mac" ? 47 : 45)),
          panelTop: box.top, panelRight: box.right, panelWidth: box.width,
          invokerBottom: anchor.bottom, invokerRight: anchor.right,
          invoker: narrow ? "overflow" : "Address all",
          micInline: toolbar.contains(mic),
          menuClosed: document.querySelector('.view-mode-toolbar__overflow-popover')?.getAttribute('aria-hidden') === 'true',
          overflowPaintedOpen: invoker.getAttribute('data-chooser-open') === 'true',
          overflowFill: getComputedStyle(invoker).backgroundColor,
          scope: scope.textContent,
          includeChecked: checkbox?.checked ?? null,
          checkboxSize: checkbox?.getBoundingClientRect().width ?? null,
          checkboxFill: checkbox ? getComputedStyle(checkbox).backgroundColor : null,
          selectWidth: select.getBoundingClientRect().width,
          selectBackground: getComputedStyle(select).backgroundColor,
          selectFocusOutline: getComputedStyle(select).outlineColor,
          panelBackground: getComputedStyle(panel).backgroundColor,
          panelBorder: getComputedStyle(panel).borderColor,
          runLabel: run.textContent,
          runDisabled: run.disabled,
          runBackground: getComputedStyle(run).backgroundColor,
          triggerBorder: getComputedStyle(invoker).borderColor,
          triggerBackground: getComputedStyle(invoker).backgroundColor,
        };
  }, width === 900);
}

async function captureHeldAddressChooser(browser, viteUrl, driverUrl, platform, theme, width) {
  evidence.colorScheme = "mixed";
  const content = "# Held comments\n\nOne passage and another passage require review.\n";
  const root = fixture(`${platform.id}-15-held-${theme}-${width}`, content);
  const ids = [];
  for (const [index, phrase] of ["One passage", "another passage"].entries()) {
    const threads = await post(driverUrl, "create_comment", {
      root, path: "notes.md", author: "reviewer", body: `Held review ${index + 1}`,
      anchor: { content, utf16Offset: content.indexOf(phrase), utf16Length: phrase.length },
      timestamp: Date.now() - 60_000 + index,
    });
    const created = threads.find((thread) => !ids.includes(thread.id));
    if (!created) throw new Error("D23 did not return the newly created comment");
    ids.push(created.id);
  }
  // Mark the ordinary first comment load so opening the page does not reconcile a newly
  // addressed batch as an abandoned run. The production D23 batch appends queued targets.
  await post(driverUrl, "load_comment_threads", { root, path: "notes.md" });
  const outcome = await post(driverUrl, "address_all_with_ai", {
    root, path: "notes.md", threadIds: ids, author: "you", timestamp: Date.now(),
    runId: `15-held-${platform.id}-${theme}-${width}`,
  });
  assert.deepEqual(outcome.addressed, ids);
  await post(driverUrl, "close_project");
  const { context, page } = await newPage(browser, viteUrl, platform, width, 900, null, theme);
  try {
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.getByRole("button", { name: "Hide Timeline" }).click();
    await page.evaluate(async () => {
      const faces = [...document.fonts].filter((face) => /IBM Plex Sans/.test(face.family));
      await Promise.all(faces.map((face) => face.load()));
    });
    if (width === 900) {
      await page.waitForFunction(() => document.querySelector('[data-toolbar-control="comment-address-all"]')
        ?.getAttribute("data-overflowed") === "true");
      await page.getByRole("button", { name: "More editor controls" }).click();
    }
    await page.getByRole("button", { name: /Address all/ }).click();
    const panel = page.getByRole("dialog", { name: "Address comments" });
    await panel.waitFor();
    const checkbox = panel.getByRole("checkbox", { name: "include them too" });
    await checkbox.waitFor();
    for (const choice of ["unchecked", "checked"]) {
      if (choice === "checked") await checkbox.click();
      const chooser = await measureAddressChooser(page, width);
      assert.equal(chooser.scope, "Address all · 2 open comments · 2 already in an agent run —");
      assert.equal(chooser.includeChecked, choice === "checked");
      assert.equal(chooser.runDisabled, choice === "unchecked");
      await snapshot(page, `${platform.id}-15-chooser-${theme}-${width}-held-${choice}`, null,
        { chooser, fixture: { kind: "D23 production queued batch address", targetIds: ids } });
    }
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureVoiceSettingsControls(browser, viteUrl, driverUrl, platform) {
  evidence.colorScheme = "mixed";
  const root = fixture(`${platform.id}-voice-settings-controls`);
  await post(driverUrl, "close_project");
  const { context, page, setup: owner } = await newPage(browser, viteUrl, platform, 1400, 900,
    (tab) => installVoiceCaptureFixture(tab, driverUrl));
  const record = async (state) => {
    await page.evaluate(() => document.fonts.ready);
    const selectedOption = await page.locator("#settings-voice-input option:checked").textContent();
    await snapshot(page, `${platform.id}-14b-controls-${state}`, ".settings-dialog", {
      fixture: { kind: "typed test-only voice status over D23", boundary: "get_voice_status" },
      theme: state.startsWith("dark") ? "dark" : "light",
      selectedOption: selectedOption?.trim() ?? null,
    });
  };
  const refresh = async () => {
    await page.getByRole("button", { name: "Refresh voice status" }).click();
    await page.getByRole("button", { name: "Refresh voice status" }).isEnabled();
  };
  try {
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.locator(".cm-content:visible").waitFor();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("switch", { name: "Enable voice" }).waitFor();
    await record("light-on");
    await owner.setStatus({ capture_active: true });
    await refresh();
    await page.getByRole("switch", { name: "Enable voice" }).isDisabled();
    await record("light-capture-active");
    await owner.setStatus({ enabled: false, capture_active: false });
    await refresh();
    await page.getByRole("switch", { name: "Enable voice" }).waitFor();
    await page.getByText("Off", { exact: true }).waitFor();
    await record("light-off");
    await owner.setStatus({ enabled: true, selected_device_id: null, device_issue: "no_device", devices: [] });
    await refresh();
    await page.locator("#settings-voice-input[aria-invalid='true']").waitFor();
    await record("light-device-error");
    await owner.setStatus({ selected_device_id: "opaque-device-47", selected_device_name: "Travel USB microphone",
      device_issue: "selected_unavailable", devices: [] });
    await refresh();
    await page.waitForFunction(() => document.querySelector("#settings-voice-input")?.value === "opaque-device-47");
    await record("light-selected-unavailable");
    await owner.setStatus({ selected_device_id: null, selected_device_name: null, device_issue: "no_device" });
    await refresh();
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await record("dark-device-error");
    await page.setViewportSize({ width: 520, height: 900 });
    await page.locator("#settings-voice-heading").evaluate((heading) => heading.scrollIntoView({ block: "start" }));
    await record("dark-narrow-device-error");
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureProjectOpen(browser, viteUrl, driverUrl, platform) {
  const root = fixture(`${platform.id}-project-open`);
  await post(driverUrl, "close_project");
  const { context, page } = await newPage(browser, viteUrl, platform);
  try {
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.locator(".cm-content:visible").waitFor();
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProjectFolder(projectRoot), root);
    await page.locator(".shell-status--project-open").waitFor();
    for (const width of [700, 520, 430]) {
      await page.setViewportSize({ width, height: 900 });
      await snapshot(page, `${platform.id}-13g-already-here-${width}`, ".shell-status--project-open");
    }
    const missing = join(root, "missing-long-name-for-clipping-2026-q1-partner-launch-messaging");
    await page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProjectFolder(projectRoot), missing);
    await page.locator(".shell-status--project-open").filter({ hasText: "couldn’t" }).waitFor();
    for (const width of [700, 520, 430]) {
      await page.setViewportSize({ width, height: 900 });
      await snapshot(page, `${platform.id}-13g-failed-${width}`, ".shell-status--project-open");
    }
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureHeldProjectRouting(browser, viteUrl, driverUrl, platform) {
  const root = fixture(`${platform.id}-j9-held`);
  const missingRoot = join(root, "missing-long-name-for-clipping-2026-q1-partner-launch-messaging");
  await post(driverUrl, "close_project");
  const { context, page, setup: routing } = await newPage(
    browser, viteUrl, platform, 1400, 900,
    (newPage) => holdProjectRouting(newPage, driverUrl),
  );
  let held = null;
  try {
    held = routing.arm(root);
    const opening = page.evaluate((projectRoot) =>
      window.__EMEND_E2E__?.openProjectFolder(projectRoot), root);
    opening.catch(() => {});
    await captureHeldProjectOpen(page, platform, held, "13a-requesting", "requesting",
      `Opening ${platform.id}-j9-held…`);
    await page.getByRole("button", { name: "Dismiss" }).click();
    await captureHiddenProjectOpen(page, platform, held, "13a-request-dismissed");
    held.release();
    await opening;
    assert.equal(held.routeOutcome?.status, "adopted_here", "welcome request must adopt this fixture");
    await page.locator(".project-rail").waitFor({ state: "visible" });
    assert.equal(await page.locator(".shell-status--project-open").count(), 0,
      "Adopted here clears the J9 band");
    await snapshot(page, `${platform.id}-13a-adopted-clear`, null, {
      fixture: { kind: "real D23 route", root, backendRequestId: held.notice.request_id,
        terminal: held.routeOutcome.status, expectedState: "adopted-clear" },
      sourceRevision: evidence.sourceRevision,
    });
    held = null;

    // The direct D23 fixture entry opens a document; the requests below still take the product
    // folder-choice route, now against a window already authoring in its adopted project.
    await page.evaluate((projectRoot) =>
      window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await page.locator(".cm-content:visible").waitFor();

    held = routing.arm(missingRoot);
    const failedRequest = page.evaluate((projectRoot) =>
      window.__EMEND_E2E__?.openProjectFolder(projectRoot), missingRoot);
    failedRequest.catch(() => {});
    const failureText = `Emend couldn’t open ${missingRoot.split(/[\\/]/).pop()}. That folder isn’t available to Emend.`;
    await captureHeldProjectOpen(page, platform, held, "13e-requesting", "requesting",
      `Opening ${missingRoot.split(/[\\/]/).pop()}…`);
    await page.getByRole("button", { name: "Dismiss" }).click();
    await captureHiddenProjectOpen(page, platform, held, "13e-request-dismissed");
    held.release();
    await failedRequest;
    assert.equal(held.routeOutcome?.status, "failed", "missing folder must remain a failed real route");
    await page.locator(".shell-status--project-open").filter({ hasText: failureText }).waitFor();
    const terminal = await inspectProjectOpenBand(page);
    assert.equal(terminal.text, failureText, "non-adopted outcome must return after Dismiss");
    assert.equal(terminal.actionLabel, "Try again");
    await snapshot(page, `${platform.id}-13e-terminal-return`, ".shell-status--project-open", {
      fixture: { kind: "real D23 route", root: missingRoot,
        backendRequestId: held.notice.request_id, terminal: held.routeOutcome,
        expectedState: "non-adopted-terminal-return" },
      sourceRevision: evidence.sourceRevision,
      verifiedState: terminal,
    });
    held = null;

    held = routing.arm(missingRoot);
    const retry = page.getByRole("button", { name: "Try again" });
    await retry.focus();
    await page.keyboard.press("Enter");
    await captureHeldProjectOpen(page, platform, held, "13f-retry-pending", "retry-pending", failureText);
    await page.getByRole("button", { name: "Dismiss" }).click();
    await captureHiddenProjectOpen(page, platform, held, "13f-retry-dismissed");
    held.release();
    await page.locator(".shell-status--project-open").filter({ hasText: failureText }).waitFor();
    const retryTerminal = await inspectProjectOpenBand(page);
    assert.equal(retryTerminal.actionLabel, "Try again");
    assert.equal(retryTerminal.ariaBusy, false);
    await snapshot(page, `${platform.id}-13f-terminal-return`, ".shell-status--project-open", {
      fixture: { kind: "real D23 route", root: missingRoot,
        backendRequestId: held.notice.request_id, terminal: held.routeOutcome,
        expectedState: "non-adopted-retry-terminal-return" },
      sourceRevision: evidence.sourceRevision,
      verifiedState: retryTerminal,
    });
    held = null;
  } finally {
    held?.release();
    await context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureFallback(browser, viteUrl, driverUrl, platform) {
  await post(driverUrl, "close_project");
  const { context, page } = await newPage(browser, viteUrl, platform);
  try {
    const thrown = page.waitForEvent("pageerror");
    await page.evaluate(() => window.__EMEND_E2E__?.triggerRenderFailure());
    await thrown;
    await page.locator(".render-failure").waitFor();
    await snapshot(page, `${platform.id}-12-author-no-project`);
  } finally {
    await context.close();
    await post(driverUrl, "close_project");
  }
  const root = fixture(`${platform.id}-fallback`);
  const author = await newPage(browser, viteUrl, platform);
  try {
    await author.page.evaluate((projectRoot) => window.__EMEND_E2E__?.openProject(projectRoot, "notes.md"), root);
    await author.page.locator(".cm-content:visible").waitFor();
    const thrown = author.page.waitForEvent("pageerror");
    await author.page.evaluate(() => window.__EMEND_E2E__?.triggerRenderFailure());
    await thrown;
    await author.page.locator(".render-failure").waitFor();
    await snapshot(author.page, `${platform.id}-12-author-project`);
    // A held remount hydration leaves the visible fallback in its real pending phase. The
    // supervisor's own bounded deadline then reaches its failed-request presentation.
    let releaseProject;
    const projectReleased = new Promise((resolveRelease) => { releaseProject = resolveRelease; });
    const holdRemount = async (route) => {
      await projectReleased;
      try { await route.continue(); } catch { /* Timed-out remount already closed its request. */ }
    };
    await author.page.route(`${driverUrl}/current_project`, holdRemount);
    try {
      await author.page.getByRole("button", { name: "Reload window" }).click();
      await author.page.getByRole("button", { name: "Reloading window…" }).waitFor();
      await snapshot(author.page, `${platform.id}-12-reload-pending`);
      await author.page.getByText("Emend couldn’t reload this window. Try again.").waitFor({ timeout: 20_000 });
      await snapshot(author.page, `${platform.id}-12-reload-failed`);
    } finally {
      releaseProject();
      await author.page.unroute(`${driverUrl}/current_project`, holdRemount);
    }
  } finally {
    await author.context.close();
    await post(driverUrl, "close_project");
  }
}

async function captureUnestablishedFallback(browser, viteUrl, driverUrl, platform) {
  await post(driverUrl, "close_project");
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  });
  await context.addInitScript((reported) => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: reported });
  }, platform.navigatorPlatform);
  const page = await context.newPage();
  let releaseProject;
  const projectReleased = new Promise((resolveRelease) => { releaseProject = resolveRelease; });
  const holdHydration = async (route) => {
    await projectReleased;
    try { await route.continue(); } catch { /* The failed tree no longer owns the request. */ }
  };
  await page.route(`${driverUrl}/current_project`, holdHydration);
  try {
    await page.goto(viteUrl);
    await page.locator(".render-recovery-attempt").waitFor({ state: "attached" });
    const thrown = page.waitForEvent("pageerror");
    await page.evaluate(async () => {
      await new Promise((resolvePaint) => requestAnimationFrame(() => requestAnimationFrame(resolvePaint)));
      window.__EMEND_E2E__?.triggerRenderFailure();
    });
    await thrown;
    await page.locator(".render-failure").waitFor();
    await snapshot(page, `${platform.id}-12-unestablished`);
  } finally {
    releaseProject();
    await page.unroute(`${driverUrl}/current_project`, holdHydration);
    await context.close();
  }
}

async function main() {
  mkdirSync(output, { recursive: true });
  const revision = spawn("git", ["rev-parse", "HEAD"], { cwd: repository, stdio: ["ignore", "pipe", "ignore"] });
  evidence.sourceRevision = await new Promise((resolveRevision, reject) => {
    let value = "";
    revision.stdout.on("data", (chunk) => { value += chunk; });
    revision.on("error", reject);
    revision.on("close", (code) => code === 0 ? resolveRevision(value.trim()) : reject(new Error("git rev-parse failed")));
  });
  const { viteUrl, driverUrl } = await startServers();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const platform of platformNames) {
      await runScenario(`${platform.id} core`, () => captureCore(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} quote`, () => captureQuote(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} comment`, () => captureComment(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} j10 blocked`, () => captureJ10Blocked(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} j10 nested`, () => captureJ10Nested(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} j10 eligible`, () => captureJ10Eligible(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} j10 commit refusal timeline`, () => captureJ10CommitRefusal(browser, viteUrl, driverUrl, platform, "timeline"));
      await runScenario(`${platform.id} j10 commit refusal popover`, () => captureJ10CommitRefusal(browser, viteUrl, driverUrl, platform, "popover"));
      await runScenario(`${platform.id} j10 withdrawn`, () => captureJ10Withdrawn(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} j10 linked`, () => captureJ10Linked(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} j10 run held`, () => captureJ10RunHeld(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} rail`, () => captureRail(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} rail unavailable`, () => captureRailUnavailable(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} recovery`, () => captureRecovery(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} D27 legacy`, () => captureLegacyUnsupported(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} pathless`, () => capturePathless(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} toolbar`, () => captureToolbar(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} voice`, () => captureVoice(browser, viteUrl, driverUrl, platform));
      if (process.env.EMEND_ALIGNMENT_SCENARIO?.includes("refresh23 dark")) {
        await runScenario(`${platform.id} refresh23 dark J12 freeze`,
          () => captureVoice(browser, viteUrl, driverUrl, platform, "dark", true));
      }
      if (process.env.EMEND_ALIGNMENT_SCENARIO?.includes("14b model row")) {
        for (const theme of ["light", "dark"]) {
          await runScenario(`${platform.id} 14b model row ${theme}`,
            () => captureVoiceModelSettings(browser, viteUrl, driverUrl, platform, theme));
        }
      }
      if (process.env.EMEND_ALIGNMENT_SCENARIO?.includes("14d editor ghost")) {
        for (const theme of ["light", "dark"]) {
          await runScenario(`${platform.id} 14d editor ghost ${theme}`,
            () => captureEditorGhost(browser, viteUrl, driverUrl, platform, theme));
        }
      }
      await runScenario(`${platform.id} compact toolbar`, () => captureCompactToolbar900(browser, viteUrl, driverUrl, platform));
      if (process.env.EMEND_ALIGNMENT_SCENARIO?.includes("turn 15 chooser")) {
        for (const theme of ["light", "dark"]) {
          await runScenario(`${platform.id} turn 15 chooser ${theme}`,
            () => captureAddressChooser(browser, viteUrl, driverUrl, platform, theme));
        }
        if (platform.id === "win") {
          await runScenario("win turn 15 chooser held light",
            () => captureHeldAddressChooser(browser, viteUrl, driverUrl, platform, "light", 1280));
        } else {
          await runScenario("mac turn 15 chooser held dark",
            () => captureHeldAddressChooser(browser, viteUrl, driverUrl, platform, "dark", 900));
        }
      }
      if (process.env.EMEND_ALIGNMENT_SCENARIO?.includes("refresh23 dark")) {
        await runScenario(`${platform.id} refresh23 dark compact toolbar`,
          () => captureCompactToolbar900(browser, viteUrl, driverUrl, platform, "dark"));
      }
      if (process.env.EMEND_ALIGNMENT_SCENARIO?.includes("dark voice")) {
        await runScenario(`${platform.id} dark voice`, () => captureDarkMic(browser, viteUrl, driverUrl, platform));
      }
      await runScenario(`${platform.id} composer voice error`, () => captureComposerVoiceError(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} 14b settings controls`, () => captureVoiceSettingsControls(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} integrity`, () => captureIntegrity(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} project open`, () => captureProjectOpen(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} J9 held routing`, () => captureHeldProjectRouting(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} fallback`, () => captureFallback(browser, viteUrl, driverUrl, platform));
      await runScenario(`${platform.id} unestablished fallback`, () => captureUnestablishedFallback(browser, viteUrl, driverUrl, platform));
    }
  } finally {
    writeFileSync(join(output, "measurements.json"), JSON.stringify(evidence, null, 2));
    await browser.close();
  }
  if (evidence.failures.length) {
    throw new Error(`${evidence.failures.length} capture scenarios failed; see ${join(output, "measurements.json")}`);
  }
  if (process.env.EMEND_ALIGNMENT_SCENARIO && selectedScenarios === 0) {
    throw new Error(`No capture scenario matched ${process.env.EMEND_ALIGNMENT_SCENARIO}`);
  }
  console.log(`Captured ${Object.keys(evidence.captures).length} states at ${evidence.sourceRevision}`);
}

try {
  await main();
} finally {
  for (const child of processes) {
    if (child.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
    }
  }
  rmSync(fixtureParent, { recursive: true, force: true });
}
