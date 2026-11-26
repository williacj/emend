// ABOUTME: Tests the Node-range check: package.json's engines.node may admit only Node versions
// ABOUTME: that every installed direct dependency and devDependency also admits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNodeEngines, checkRepoNodeEngines } from './node-engines.mjs';

// `declared` maps each fixture dependency to its engines.node; null declares none.
function check(root, declared) {
  const names = Object.keys(declared);
  return checkNodeEngines({
    packageJson: {
      ...(root === null ? {} : { engines: { node: root } }),
      dependencies: Object.fromEntries(names.slice(0, 1).map((name) => [name, '*'])),
      devDependencies: Object.fromEntries(names.slice(1).map((name) => [name, '*'])),
    },
    readDependencyManifest: (name) => (declared[name] === null ? {} : { engines: { node: declared[name] } }),
  });
}

function assertOneFaultNaming(faults, name) {
  assert.equal(faults.length, 1, faults.join('\n'));
  assert.ok(faults[0].includes(name), faults[0]);
}

test('the repository engines.node admits only Node versions its installed direct dependencies accept', () => {
  assert.deepEqual(checkRepoNodeEngines(), []);
});

test('an open range that spans a gap in a dependency range is a fault naming that dependency', () => {
  assertOneFaultNaming(check('>=20', { 'fixture-vite': '^20.19.0 || >=22.12.0' }), 'fixture-vite');
});

test('a range reaching past a dependency upper bound is a fault naming that dependency', () => {
  assertOneFaultNaming(check('>=20.19.0', { 'fixture-capped': '^20.19.0' }), 'fixture-capped');
});

test('a range inside every dependency range reports no fault', () => {
  const faults = check('^20.19.0 || ^22.13.0 || >=24.0.0', {
    'fixture-vite': '^20.19.0 || >=22.12.0',
    'fixture-jsdom': '^20.19.0 || ^22.13.0 || >=24.0.0',
  });
  assert.deepEqual(faults, []);
});

test('a package.json without engines.node is a fault', () => {
  const faults = check(null, { 'fixture-vite': '>=18' });
  assert.equal(faults.length, 1, faults.join('\n'));
  assert.match(faults[0], /no engines\.node/);
});

test('a dependency or devDependency declaring no engines.node constrains nothing', () => {
  assert.deepEqual(check('>=1', { 'fixture-silent': null, 'fixture-quiet': null }), []);
});

test('each comparator form is read with its exact Node version boundaries', () => {
  const admits = (root, dependency) => check(root, { 'fixture-dep': dependency }).length === 0;
  // [range, an equal spelling in >= and < bounds]
  const equal = [
    ['^20.19.0', '>=20.19.0 <21.0.0'],
    ['^0.2.3', '>=0.2.3 <0.3.0'],
    ['^0.0.3', '>=0.0.3 <0.0.4'],
    ['^0.0', '>=0.0.0 <0.1.0'],
    ['~22.13.1', '>=22.13.1 <22.14.0'],
    ['~22', '>=22.0.0 <23.0.0'],
    ['20', '>=20.0.0 <21.0.0'],
    ['20.x', '>=20.0.0 <21.0.0'],
    ['=22.13.1', '>=22.13.1 <22.13.2'],
    ['v22.13.1', '>=22.13.1 <22.13.2'],
    ['>20', '>=21.0.0'],
    ['>20.1.2', '>=20.1.3'],
    ['>=20 <=22', '>=20.0.0 <23.0.0'],
    ['>= 10', '>=10.0.0'],
    ['*', '>=0.0.0'],
    ['>=24 || >=20 <22 || ^22.0.0', '>=20.0.0 <23.0.0 || >=24.0.0'],
  ];
  for (const [range, bounds] of equal) {
    assert.ok(admits(range, bounds), `${range} reaches outside ${bounds}`);
    assert.ok(admits(bounds, range), `${bounds} reaches outside ${range}`);
  }
});

test('a Node range the check cannot read is a fault rather than a pass', () => {
  for (const unreadable of ['20.0.0 - 22.0.0', '>=22.0.0-rc.1', 'lts/*', '>=', '>=20 ||| 22']) {
    assertOneFaultNaming(check('>=22', { 'fixture-odd': unreadable }), 'fixture-odd');
    assertOneFaultNaming(check(unreadable, { 'fixture-dep': '>=0' }), 'package.json');
  }
});

test('a direct dependency that is not installed is a fault naming it', () => {
  const faults = checkNodeEngines({
    packageJson: { engines: { node: '>=20' }, dependencies: { 'fixture-absent': '*' } },
    readDependencyManifest: () => {
      throw new Error('ENOENT');
    },
  });
  assertOneFaultNaming(faults, 'fixture-absent');
});
