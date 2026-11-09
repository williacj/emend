// ABOUTME: Pins the sccache launcher/task templates as genuinely host-portable — every host-specific
// ABOUTME: value is a substitutable placeholder, and no host's literal paths are baked in.
//
// Why this file exists: #1900 declared the templates portable on the strength of `%USERPROFILE%`
// resolving per-account, and nothing checked that claim. It was false for FINN-PC10, whose runner
// services run as a dedicated `ghrunner` account with no `.cargo` directory at all — substituting the
// CORRECT account produced a path to a missing binary, which would have stopped that host's daemon
// and failed the workflow preflight on every job. These assertions are what that gap looked like.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..');

const launcher = () => readFileSync(join(scriptsDir, 'sccache-server.cmd'), 'utf8');
const taskXml = () => readFileSync(join(scriptsDir, 'windows-sccache-task.xml'), 'utf8');
const runbook = () => readFileSync(join(repoRoot, 'docs', 'ci-windows-runner.md'), 'utf8');

// The three values that genuinely differ between WILLIACJ-01 and FINN-PC10, measured on both hosts.
const PLACEHOLDERS = ['__SCCACHE_EXE__', '__SCCACHE_DIR__'];

test('the launcher exposes the executable path as a placeholder, not a per-account guess', () => {
  const cmd = launcher();
  assert.match(cmd, /__SCCACHE_EXE__/, 'the sccache executable must be substitutable per host');
  // The specific regression: resolving the binary through %USERPROFILE% assumes the service account
  // owns a .cargo directory. FINN-PC10's ghrunner does not.
  assert.doesNotMatch(
    cmd.replace(/^REM.*$/gm, ''),
    /%USERPROFILE%\\\.cargo/i,
    'must not resolve sccache through %USERPROFILE%\\.cargo — a service account may have no such directory'
  );
});

test('the launcher exposes the cache directory as a placeholder', () => {
  // WILLIACJ-01 wants %LOCALAPPDATA%\Mozilla\sccache\cache (its existing warm cache); FINN-PC10 sets
  // an explicit C:\sccache\cache because a service account has no interactive profile to resolve
  // %LOCALAPPDATA% through. Both are expressible only if this is substitutable.
  assert.match(launcher(), /set SCCACHE_DIR=__SCCACHE_DIR__/);
});

test('the launcher fails loudly when the substituted executable is absent', () => {
  // A missing binary must not present as "task ran, no daemon" — that is indistinguishable from the
  // #1178 failure it exists to prevent, and the workflow preflight is the only thing that catches it.
  const cmd = launcher();
  assert.match(cmd, /if not exist "__SCCACHE_EXE__"/);
  assert.match(cmd, /exit \/b 1/);
});

test('neither template bakes in any host literal path or account', () => {
  for (const [name, text] of [['sccache-server.cmd', launcher()], ['windows-sccache-task.xml', taskXml()]]) {
    const body = text.replace(/^REM.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
    for (const literal of [/C:\\Users\\williacj/i, /C:\\Users\\CJ\\/i, /C:\\tools/i, /ghrunner/i]) {
      assert.doesNotMatch(body, literal, `${name} must not hardcode a host-specific path or account`);
    }
  }
});

test('the task XML keeps __USER__ as its only placeholder', () => {
  const xml = taskXml();
  assert.match(xml, /<UserId>__USER__<\/UserId>/);
});

test('substituting every placeholder leaves nothing unsubstituted', () => {
  let cmd = launcher();
  for (const p of PLACEHOLDERS) cmd = cmd.split(p).join('C:\\substituted\\value');
  let xml = taskXml().split('__USER__').join('.\\someaccount');
  // Comments legitimately NAME the placeholders; strip them before asserting none survive.
  const cmdBody = cmd.replace(/^REM.*$/gm, '');
  const xmlBody = xml.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(cmdBody, /__[A-Z_]+__/, 'launcher has an unsubstituted placeholder');
  assert.doesNotMatch(xmlBody, /__[A-Z_]+__/, 'task XML has an unsubstituted placeholder');
});

// Locates the install recipe itself rather than searching the whole runbook. Each placeholder is
// NAMED in three places — prose, the per-host value table, and the recipe — so a whole-document
// `includes()` stays green even when the recipe's actual substitution step is deleted, which is the
// one edit that breaks a real install. Anchored on the two lines that make a block the install
// recipe rather than an illustration.
function installRecipe(doc) {
  const blocks = doc.match(/```powershell\n[\s\S]*?```/g) ?? [];
  const recipe = blocks.filter(
    (b) => b.includes('Register-ScheduledTask') && b.includes('sccache-server')
  );
  assert.equal(
    recipe.length,
    1,
    `expected exactly one install recipe block in docs/ci-windows-runner.md, found ${recipe.length}`
  );
  return recipe[0];
}

test('the runbook install recipe substitutes every placeholder the templates carry', () => {
  // The recipe is the only thing that turns these templates into a working install, so a placeholder
  // it forgets is a silently broken host — exactly the #1900 defect, one level up. Assert the
  // SUBSTITUTION, not the mention: a recipe that merely names __SCCACHE_DIR__ in a comment while
  // omitting its -replace emits a launcher carrying a literal placeholder, and that host gets no
  // daemon. (Round-3 review proved the previous whole-document assertion survived exactly that cut.)
  const recipe = installRecipe(runbook());
  for (const p of [...PLACEHOLDERS, '__USER__']) {
    assert.match(
      recipe,
      new RegExp(`-replace\\s+'${p}'`),
      `the install recipe must -replace ${p}, not merely mention it`
    );
  }
});

test('the install recipe substitutes exactly the placeholders the templates carry', () => {
  // The other direction: a placeholder added to a template but never wired into the recipe is the
  // same silent breakage, and a -replace left behind for a placeholder that no longer exists is dead
  // weight that reads as coverage. Keep the two sets identical.
  const recipe = installRecipe(runbook());
  const substituted = [...new Set([...recipe.matchAll(/-replace\s+'(__[A-Z_]+__)'/g)].map((m) => m[1]))].sort();
  // Deduped across BOTH files: the launcher's comments legitimately name the XML's __USER__ while
  // explaining why it is not the only host-specific value, so the union is a set, not a list.
  const declared = [
    ...new Set([
      ...[...launcher().matchAll(/__[A-Z_]+__/g)].map((m) => m[0]),
      ...[...taskXml().matchAll(/<UserId>(__[A-Z_]+__)<\/UserId>/g)].map((m) => m[1]),
    ]),
  ].sort();
  assert.deepEqual(substituted, declared);
});
