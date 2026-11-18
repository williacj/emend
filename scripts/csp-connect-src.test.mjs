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

// Every directive as [lowercased name, source tokens], duplicates kept: a duplicate must never hide an earlier one.
function parseCsp(csp) {
  const directives = [];
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) directives.push([name.toLowerCase(), sources]);
  }
  return directives;
}

const sourcesOf = (directives, wanted) => directives.filter(([name]) => name === wanted).map(([, sources]) => sources);

function connectSrcViolations(csp) {
  const all = sourcesOf(parseCsp(csp), 'connect-src');
  if (all.length === 0) return ["connect-src must be exactly 'self', found none"];
  return all
    .filter((sources) => !(sources.length === 1 && sources[0] === "'self'"))
    .map((sources) => `connect-src must be exactly 'self', found ${JSON.stringify(sources)}`);
}

function networkOriginViolations(csp) {
  const found = [];
  for (const [name, sources] of parseCsp(csp)) {
    for (const source of sources) {
      if (NETWORK_ORIGIN.test(source) || source.includes('*')) found.push(`${name} admits ${source}`);
    }
  }
  return found;
}

// A platform override that sets a policy must confine connect-src to 'self'; it falls back to default-src as a
// browser does, and a policy with neither leaves connect-src unrestricted.
function platformConnectSrcViolations(csp) {
  const directives = parseCsp(csp);
  const explicit = sourcesOf(directives, 'connect-src');
  const governing = explicit.length > 0 ? explicit : sourcesOf(directives, 'default-src');
  if (governing.length === 0) return ['connect-src is unrestricted: neither connect-src nor default-src is set'];
  return governing.flat().filter((source) => source !== "'self'").map((source) => `connect-src admits ${source}`);
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
  assert.equal(connectSrcViolations("connect-src https://a.example; connect-src 'self'").length, 1);
  assert.equal(connectSrcViolations("connect-src 'self'; connect-src https://a.example").length, 1);
  assert.deepEqual(networkOriginViolations("img-src https://a.example; img-src 'self'"), ['img-src admits https://a.example']);
  assert.equal(platformConnectSrcViolations("img-src 'self'").length, 1);
  assert.equal(platformConnectSrcViolations("connect-src https://a.example; connect-src 'self'").length, 1);
  assert.deepEqual(networkOriginViolations("img-src 'self' wss://x.example"), ['img-src admits wss://x.example']);
  assert.deepEqual(networkOriginViolations('img-src *'), ['img-src admits *']);
  assert.deepEqual(networkOriginViolations("img-src 'self' *.example.com"), ['img-src admits *.example.com']);
  assert.deepEqual(networkOriginViolations('default-src *'), ['default-src admits *']);
  assert.deepEqual(platformConnectSrcViolations("connect-src 'self' http://localhost:1420"), ['connect-src admits http://localhost:1420']);
  assert.deepEqual(platformConnectSrcViolations('default-src https://a.example'), ['connect-src admits https://a.example']);
});

test('the csp checks do not read devCsp', () => {
  const dev = { app: { security: { devCsp: 'connect-src http://localhost:1420' } } };
  assert.equal(productionCsp(dev), undefined);
});
