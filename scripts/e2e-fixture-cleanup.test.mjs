// ABOUTME: Pins the e2e fixture teardown's bounded, step-naming cleanup (#1554) against real
// ABOUTME: sockets, a real directory, and a real concurrent writer — no stubbed filesystem or fetch.
//
// #1383 made teardown await `close_project`, close the page, then retry real directory removal.
// Each of those three awaits was unbounded, so a stall consumed Playwright's whole 30s test bound
// and reported only "Test timeout of 30000ms exceeded" — naming none of the three (#1554). These
// cells drive the real `createFixtureProject(...).cleanup()` composition through the production
// `post()`/`fetch` seam and assert every stall fails inside its own budget carrying the step name.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import test, { after } from "node:test";

/**
 * A real loopback TCP server standing in for the D23 driver's HTTP surface. `answers` decides
 * whether an arriving request gets a real reply or nothing at all — the stall cases need a driver
 * that accepts the connection and never answers it, exactly like the serial accept loop under a
 * blocked predecessor.
 */
async function startDriver() {
  const sockets = new Set();
  const driver = { answers: true };
  const server = createServer((socket) => {
    sockets.add(socket);
    let answered = false;
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.on("data", () => {
      if (answered || !driver.answers) return;
      answered = true;
      socket.end(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n" +
          "Connection: close\r\n\r\n{}",
      );
    });
  });
  await new Promise((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  driver.url = `http://127.0.0.1:${server.address().port}`;
  driver.close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  return driver;
}

// One driver for the whole file: `testDriverClient.mjs` reads its URL once at import, so a second
// server on a second port would be unreachable from the already-loaded client.
const driver = await startDriver();
process.env.EMEND_E2E_TEST_DRIVER_URL = driver.url;
// A `file:` URL, never a resolved filesystem path: on Windows the path form starts `C:\`, which the
// ESM loader parses as the URL scheme `c:` and rejects with ERR_UNSUPPORTED_ESM_URL_SCHEME before a
// single test registers.
const { createFixtureProject } = await import(
  new URL("../e2e/support/fixtureProject.mjs", import.meta.url).href
);

after(() => driver.close());

/** Playwright's `Page` surface the fixture uses — the two methods its own JSDoc type names. */
function fakePage({ close = async () => {} } = {}) {
  let closed = false;
  return {
    isClosed: () => closed,
    close: async () => {
      await close();
      closed = true;
    },
  };
}

/** The rejection `cleanup` produced, or `null` when it resolved. */
function cleanupFailure(project, page, options) {
  return project.cleanup(page, options).then(
    () => null,
    (error) => error,
  );
}

test("a healthy teardown closes the project and page and removes the real directory", async () => {
  const project = createFixtureProject("# fixture\n");
  const page = fakePage();
  assert.deepEqual(readdirSync(project.root), ["notes.md"]);

  // Production budgets, not test-shrunk ones: the healthy path must clear the real defaults.
  await project.cleanup(page);

  assert.equal(page.isClosed(), true);
  assert.equal(existsSync(project.root), false);
});

test("a driver that never answers close_project fails inside its budget naming that step", async () => {
  // The measured stall shape (#1554): the D23 driver serves connections serially, so a connection
  // it accepts but never answers leaves `close_project` waiting with nothing to report.
  const project = createFixtureProject("# fixture\n");
  const page = fakePage();
  driver.answers = false;
  const startedAt = Date.now();
  try {
    const error = await cleanupFailure(project, page, { budgets: { closeProject: 250 } });
    const elapsed = Date.now() - startedAt;

    assert.ok(error, "expected the unanswered close_project to fail rather than hang");
    assert.match(error.message, /close_project/);
    assert.match(error.message, /did not respond within 250ms/);
    assert.ok(elapsed < 15_000, `expected a bounded failure, took ${elapsed}ms`);
    // The page and directory are untouched: the report names the step that actually stalled.
    assert.equal(page.isClosed(), false);
    assert.equal(existsSync(project.root), true);
  } finally {
    driver.answers = true;
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("a page close that never settles fails inside its budget naming that step", async () => {
  const project = createFixtureProject("# fixture\n");
  const page = fakePage({ close: () => new Promise(() => {}) });
  try {
    const error = await cleanupFailure(project, page, { budgets: { pageClose: 250 } });

    assert.ok(error, "expected the unsettled page close to fail rather than hang");
    assert.match(error.message, /page\.close/);
    assert.match(error.message, /did not settle within 250ms/);
    // close_project already succeeded, so the report separates it from the step that stalled.
    assert.match(error.message, /completed close_project in \d+ms/);
    assert.equal(existsSync(project.root), true);
  } finally {
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("a removal that cannot finish inside its budget names the step, its attempts, and what survived", async () => {
  const project = createFixtureProject("# fixture\n");
  // A real tree far too large to delete in the budget below — deterministic where a raced writer is
  // not, because `rm` cannot return before it has visited every entry.
  for (let index = 0; index < 10_000; index += 1) {
    writeFileSync(path.join(project.root, `entry-${index}.md`), "x");
  }
  try {
    const error = await cleanupFailure(project, fakePage(), { budgets: { removeDirectory: 25 } });

    assert.ok(error, "expected the unfinished removal to fail rather than run unbounded");
    assert.match(error.message, /directory removal/);
    assert.match(error.message, /did not settle within 25ms/);
    assert.match(error.message, /after \d+ attempts?/);
    assert.match(error.message, /remaining entries: .*total|remaining entries: \S/);
    // The two earlier steps are reported as completed, so the report names the one that stalled.
    assert.match(error.message, /completed close_project in \d+ms, page\.close in \d+ms/);
  } finally {
    // The removal this cell interrupted is still running over the same tree, and on Windows a
    // concurrent delete surfaces as EBUSY/EPERM rather than the ENOENT `force` absorbs — so this
    // cleanup retries to tolerate the concurrent deletion.
    rmSync(project.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
});

test("a directory a live writer keeps refilling still settles inside the removal budget", async (t) => {
  // POSIX-only: the retried race is #1383's `ENOTEMPTY`, what a POSIX kernel returns for an `rmdir`
  // that a concurrent create raced. Windows reports it as `EBUSY`/`EPERM`, which this loop has
  // never retried and this card does not change.
  if (process.platform === "win32") {
    t.skip("ENOTEMPTY is the POSIX spelling of the race this loop retries");
    return;
  }
  const project = createFixtureProject("# fixture\n");
  // A real second process writing into the real fixture directory — the production race #1383
  // found, not a stubbed `rm`. Which side wins a given pass is genuinely racy, so this cell pins
  // the property that is not: teardown settles, one way or the other, inside its own budget. Before
  // #1554 the same writer kept the retry loop spinning with no bound and no report at all.
  const writer = spawn(
    process.execPath,
    [
      "-e",
      "const {writeFileSync}=require('node:fs');const {join}=require('node:path');" +
        "let n=0;for(;;)writeFileSync(join(process.argv[1],`refill-${n++}`),'x');",
      project.root,
    ],
    { stdio: "ignore" },
  );
  try {
    // Condition-based, not a sleep: start removing only once the writer is demonstrably running.
    while (readdirSync(project.root).length < 2_000) await new Promise(setImmediate);
    const startedAt = Date.now();

    const error = await cleanupFailure(project, fakePage(), {
      budgets: { removeDirectory: 500 },
    });
    const elapsed = Date.now() - startedAt;

    assert.ok(elapsed < 10_000, `expected a bounded teardown, took ${elapsed}ms`);
    if (error) {
      assert.match(error.message, /directory removal/);
      assert.match(error.message, /did not settle within 500ms/);
      assert.match(error.message, /after \d+ attempts?/);
      assert.match(error.message, /remaining entries/);
    } else {
      assert.equal(existsSync(project.root), false);
    }
  } finally {
    writer.kill("SIGKILL");
    await new Promise((resolve) => writer.once("exit", resolve));
    rmSync(project.root, { recursive: true, force: true });
  }
});

test("a removal error that is not the retried race surfaces instead of consuming the budget", async (t) => {
  // The discriminating negative: only `ENOTEMPTY` is the raced-writer case worth retrying. Anything
  // else must reach the caller with its own code, not be retried until a budget expires.
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("directory permissions gate removal this way only for a non-root POSIX user");
    return;
  }
  const project = createFixtureProject("# fixture\n");
  const locked = path.join(project.root, "locked");
  mkdirSync(locked);
  writeFileSync(path.join(locked, "kept.md"), "# kept\n");
  chmodSync(locked, 0o500);
  const startedAt = Date.now();
  try {
    const error = await cleanupFailure(project, fakePage(), {
      budgets: { removeDirectory: 5_000 },
    });

    assert.ok(error, "expected the unretried removal error to surface");
    assert.match(error.message, /directory removal/);
    assert.match(error.message, /EACCES|EPERM/);
    assert.doesNotMatch(error.message, /did not settle within/);
    assert.ok(Date.now() - startedAt < 5_000, "expected the error to surface without retrying");
  } finally {
    chmodSync(locked, 0o700);
    rmSync(project.root, { recursive: true, force: true });
  }
});

// The app reports and compares canonical paths. A fixture root left as tmpdir() gave it differs on
// hosted Windows (an 8.3 RUNNER~1 short name) and on macOS (/var -> /private/var), and J7's literal
// command grammar refuses the short name's "~" (#54).
test("a fixture project's root is already its canonical path", () => {
  const project = createFixtureProject("# fixture\n");
  try {
    assert.equal(project.root, realpathSync.native(project.root));
  } finally {
    rmSync(project.root, { recursive: true, force: true });
  }
});
