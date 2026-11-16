// ABOUTME: MEASUREMENT ONLY (#72, never merged): drives many cross-origin fetches from a Playwright Chromium page
// ABOUTME: at a loopback server that closes every connection, and counts net::ERR_* failures and source-port reuse.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import http from "node:http";
import { chromium } from "@playwright/test";
import { measureChromiumArgs } from "./chromium-args.mjs";

const CALLS = Number(process.env.STRESS_CALLS ?? 15000);
const CONCURRENCY = Number(process.env.STRESS_CONCURRENCY ?? 1);
const BATCH = Number(process.env.STRESS_BATCH ?? 1000);
const GAP_MS = Number(process.env.STRESS_GAP_MS ?? 0);
const OUT = process.env.STRESS_OUT ?? "stress-summary.json";
const REUSE_WINDOW_MS = 240_000;

function timeWaitCount() {
  if (process.platform !== "win32") return null;
  try {
    const out = execSync("netstat -ano -p tcp", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return out.split("\n").filter((l) => l.includes("TIME_WAIT")).length;
  } catch {
    return null;
  }
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

// The target, shaped like the e2e test driver: one request per connection, then the server closes.
const peerPorts = [];
const target = http.createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    Connection: "close",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { ...cors, "Content-Type": "application/json" });
    res.end("{}");
  });
});
target.keepAliveTimeout = 0;
target.on("connection", (socket) => peerPorts.push([Date.now(), socket.remotePort]));

const origin = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html", Connection: "close" });
  res.end("<!doctype html><title>stress</title>");
});

const targetPort = await listen(target);
const originPort = await listen(origin);
const args = measureChromiumArgs();
console.log(`args: ${JSON.stringify(args)}`);
console.log(`calls=${CALLS} concurrency=${CONCURRENCY} gapMs=${GAP_MS} target=${targetPort} origin=${originPort}`);

const browser = await chromium.launch({ headless: true, args });
const page = await browser.newPage();
const failuresByKind = {};
page.on("requestfailed", (request) => {
  const kind = request.failure()?.errorText ?? "unknown";
  failuresByKind[kind] = (failuresByKind[kind] ?? 0) + 1;
});
await page.goto(`http://127.0.0.1:${originPort}/`);

const timeline = [];
const started = Date.now();
let done = 0;
let pageFailed = 0;
timeline.push({ calls: 0, ms: 0, timeWait: timeWaitCount() });
while (done < CALLS) {
  const n = Math.min(BATCH, CALLS - done);
  const result = await page.evaluate(
    async ({ url, n, start, concurrency, gapMs }) => {
      let next = 0;
      let failed = 0;
      const errors = [];
      async function worker() {
        while (next < n) {
          const i = start + next++;
          try {
            const r = await fetch(`${url}?i=${i}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: "{}",
            });
            await r.text();
          } catch (e) {
            failed++;
            if (errors.length < 5) errors.push(String(e));
          }
          if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker));
      return { failed, errors };
    },
    { url: `http://127.0.0.1:${targetPort}/call`, n, start: done, concurrency: CONCURRENCY, gapMs: GAP_MS },
  );
  done += n;
  pageFailed += result.failed;
  const entry = { calls: done, ms: Date.now() - started, failed: result.failed, timeWait: timeWaitCount() };
  if (result.errors.length) entry.errors = result.errors;
  timeline.push(entry);
  console.log(JSON.stringify(entry));
}
await browser.close();
target.close();
origin.close();

// Source-port behaviour: with SO_RANDOMIZE_PORT the next connection's port is random; with the
// default allocator it is usually the previous port plus a small step.
let smallSteps = 0;
let reusedWithinWindow = 0;
const lastSeen = new Map();
for (let i = 0; i < peerPorts.length; i++) {
  const [t, port] = peerPorts[i];
  if (i > 0) {
    const d = port - peerPorts[i - 1][1];
    if (d >= 1 && d <= 8) smallSteps++;
  }
  const prev = lastSeen.get(port);
  if (prev !== undefined && t - prev < REUSE_WINDOW_MS) reusedWithinWindow++;
  lastSeen.set(port, t);
}
const ports = peerPorts.map(([, p]) => p);
const summary = {
  arm: process.env.MEASURE_ARM ?? "unknown",
  args,
  calls: CALLS,
  concurrency: CONCURRENCY,
  gapMs: GAP_MS,
  durationMs: Date.now() - started,
  pageFetchFailures: pageFailed,
  requestFailedByKind: failuresByKind,
  connectionsAccepted: peerPorts.length,
  distinctSourcePorts: lastSeen.size,
  sourcePortMin: Math.min(...ports),
  sourcePortMax: Math.max(...ports),
  sequentialStepFraction: peerPorts.length > 1 ? smallSteps / (peerPorts.length - 1) : null,
  sourcePortReusedWithin240s: reusedWithinWindow,
  firstPorts: ports.slice(0, 20),
  timeline,
};
writeFileSync(OUT, JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, timeline: undefined }, null, 2));
