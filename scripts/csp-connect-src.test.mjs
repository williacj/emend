// ABOUTME: Pins the production CSP's `connect-src 'self'` (TD-9, FR-X-2): the webview has no external network egress.
// ABOUTME: Reads `app.security.csp` from the base and platform Tauri configs; never reads `devCsp`, which TD-9 leaves to the dev server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const TAURI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri');
const NETWORK_ORIGIN = /^(?:https?|wss?):/i;
const PLATFORM_CONFIGS = ['tauri.windows.conf.json', 'tauri.macos.conf.json'];

const readConfig = (name) => JSON.parse(readFileSync(join(TAURI_DIR, name), 'utf8'));

// The production policy a config sets, or undefined when it sets none. Only `csp` is read.
function productionCsp(config) {
  return config?.app?.security?.csp;
}

// Directive name (lowercased) -> its source tokens.
function parseCsp(csp) {
  const directives = new Map();
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

function connectSrcViolations(csp) {
  const sources = parseCsp(csp).get('connect-src');
  return sources !== undefined && sources.length === 1 && sources[0] === "'self'"
    ? []
    : [`connect-src must be exactly 'self', found ${JSON.stringify(sources)}`];
}

function networkOriginViolations(csp) {
  const found = [];
  for (const [name, sources] of parseCsp(csp)) {
    for (const source of sources) if (NETWORK_ORIGIN.test(source)) found.push(`${name} admits ${source}`);
  }
  return found;
}

// A platform override that sets a policy must not widen connect-src; falls back to default-src as a browser does.
function platformConnectSrcViolations(csp) {
  const directives = parseCsp(csp);
  const sources = directives.get('connect-src') ?? directives.get('default-src') ?? [];
  return sources.filter((source) => source !== "'self'").map((source) => `connect-src admits ${source}`);
}

test("production csp connect-src is exactly 'self' (TD-9)", () => {
  const csp = productionCsp(readConfig('tauri.conf.json'));
  assert.equal(typeof csp, 'string', 'tauri.conf.json must set app.security.csp');
  assert.deepEqual(connectSrcViolations(csp), []);
});

test('production csp admits no network origin in any directive (TD-9)', () => {
  const csp = productionCsp(readConfig('tauri.conf.json'));
  assert.equal(typeof csp, 'string', 'tauri.conf.json must set app.security.csp');
  assert.deepEqual(networkOriginViolations(csp), []);
});

test("platform configs never admit an origin other than 'self' in connect-src (TD-9)", () => {
  for (const name of PLATFORM_CONFIGS) {
    const csp = productionCsp(readConfig(name));
    if (csp === undefined) continue;
    assert.deepEqual(platformConnectSrcViolations(csp), [], name);
  }
});

test('the csp checks reject an extra connect-src origin and a network origin in any directive', () => {
  const good = "default-src 'self'; connect-src 'self'; img-src 'self' data:";
  assert.deepEqual(connectSrcViolations(good), []);
  assert.deepEqual(networkOriginViolations(good), []);
  assert.equal(connectSrcViolations("connect-src 'self' https://api.github.com").length, 1);
  assert.equal(connectSrcViolations("default-src 'self'").length, 1);
  assert.deepEqual(networkOriginViolations("img-src 'self' wss://x.example"), ['img-src admits wss://x.example']);
  assert.deepEqual(platformConnectSrcViolations("connect-src 'self' http://localhost:1420"), ['connect-src admits http://localhost:1420']);
  assert.deepEqual(platformConnectSrcViolations('default-src https://a.example'), ['connect-src admits https://a.example']);
});

test('the csp checks do not read devCsp', () => {
  const dev = { app: { security: { devCsp: 'connect-src http://localhost:1420' } } };
  assert.equal(productionCsp(dev), undefined);
});
