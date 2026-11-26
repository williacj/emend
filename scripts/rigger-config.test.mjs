// ABOUTME: Proves rigger.config.mjs resolves: agent files, makers, judges (or the owner) and
// ABOUTME: kinds' provisioning steps are all declared, so a typo fails here, not at dispatch.

import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findRiggerConfigFaults(config, root) {
  const faults = [];
  const roles = config.roles ?? {};
  for (const [name, role] of Object.entries(roles)) {
    if (typeof role.agent !== 'string' || !isFile(resolve(root, role.agent))) {
      faults.push(`role "${name}" agent ${JSON.stringify(role.agent)} names no file`);
    }
  }
  for (const [kind, spec] of Object.entries(config.kinds ?? {})) {
    if (!Object.hasOwn(roles, spec.maker)) {
      faults.push(`kind "${kind}" maker ${JSON.stringify(spec.maker)} is not a declared role`);
    }
    for (const judge of spec.judges ?? []) {
      const name = typeof judge === 'string' ? judge : judge?.role;
      if (name !== 'owner' && !Object.hasOwn(roles, name)) {
        faults.push(`kind "${kind}" judge ${JSON.stringify(name)} is neither a declared role nor 'owner'`);
      }
    }
    for (const step of spec.provisioning ?? []) {
      if (!Object.hasOwn(config.provisioning ?? {}, step)) {
        faults.push(`kind "${kind}" provisioning step ${JSON.stringify(step)} is not a declared step`);
      }
    }
  }
  return faults;
}

const { default: config } = await import(pathToFileURL(resolve(repoRoot, 'rigger.config.mjs')).href);

test('every role and kind in rigger.config.mjs resolves', () => {
  assert.deepEqual(findRiggerConfigFaults(config, repoRoot), []);
});

const fixture = {
  roles: { engineer: { agent: '.claude/agents/engineer.md' }, reviewer: { agent: '.claude/agents/reviewer.md' } },
  kinds: { change: { maker: 'engineer', judges: [{ role: 'reviewer' }, 'owner'], provisioning: ['npm-ci'] } },
  provisioning: { 'npm-ci': { run: 'npm ci' } },
};

test('the fixture config is free of faults', () => {
  assert.deepEqual(findRiggerConfigFaults(fixture, repoRoot), []);
});

test('a role agent path naming a missing file is a fault', () => {
  const roles = { ...fixture.roles, engineer: { agent: '.claude/agents/missing.md' } };
  assert.equal(findRiggerConfigFaults({ ...fixture, roles }, repoRoot).length, 1);
});

test('a role agent path naming a directory is a fault', () => {
  const roles = { ...fixture.roles, engineer: { agent: '.claude/agents' } };
  assert.equal(findRiggerConfigFaults({ ...fixture, roles }, repoRoot).length, 1);
});

test('a maker naming an undeclared role is a fault', () => {
  const kinds = { change: { ...fixture.kinds.change, maker: 'nobody' } };
  assert.equal(findRiggerConfigFaults({ ...fixture, kinds }, repoRoot).length, 1);
});

test('string and object judges naming undeclared roles are faults, and owner is accepted', () => {
  const judges = ['ghost', { role: 'phantom' }, 'owner', { role: 'reviewer' }];
  const kinds = { change: { maker: 'engineer', judges } };
  assert.equal(findRiggerConfigFaults({ ...fixture, kinds }, repoRoot).length, 2);
});

test('a kind naming an undeclared provisioning step is one fault that names it', () => {
  const kinds = { change: { ...fixture.kinds.change, provisioning: ['npm-ci', 'npm-cl'] } };
  const faults = findRiggerConfigFaults({ ...fixture, kinds }, repoRoot);
  assert.equal(faults.length, 1);
  assert.match(faults[0], /"npm-cl"/);
});

test('kinds naming only declared provisioning steps have no provisioning fault', () => {
  const provisioning = { ...fixture.provisioning, 'cargo-build': { run: 'cargo build' } };
  const kinds = {
    change: { ...fixture.kinds.change, provisioning: ['npm-ci', 'cargo-build'] },
    spec: { ...fixture.kinds.change, provisioning: ['npm-ci'] },
  };
  assert.deepEqual(findRiggerConfigFaults({ ...fixture, kinds, provisioning }, repoRoot), []);
});
