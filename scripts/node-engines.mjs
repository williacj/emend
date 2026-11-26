// ABOUTME: The Node-range check: package.json's engines.node may admit only Node versions that every
// ABOUTME: installed direct dependency and devDependency declaring engines.node also admits.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Covers release versions, which is what Node ships, in these forms: `||` alternatives of
// space-separated comparators (^ ~ >= > <= < =, or none) over full, partial or x versions.
// Anything else (hyphen ranges, prereleases) throws, so an unread range never passes.
const COMPARATOR = /^(\^|~|>=|>|<=|<|=)?v?(\d+|[x*])(?:\.(\d+|[x*]))?(?:\.(\d+|[x*]))?$/;

function compare(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

const ZERO = [0, 0, 0];
const UNBOUNDED = [Infinity, 0, 0];
const later = (a, b) => (compare(a, b) >= 0 ? a : b);
const earlier = (a, b) => (compare(a, b) <= 0 ? a : b);

// The first version past every version that shares `version`'s parts up to `index`.
function bump(version, index) {
  return version.map((part, i) => (i < index ? part : i === index ? part + 1 : 0));
}

// One comparator as a half-open interval [low, high).
function comparatorInterval(text) {
  const match = COMPARATOR.exec(text);
  if (!match) throw new Error(`unsupported Node range syntax "${text}"`);
  const [, operator = '=', ...raw] = match;
  const wildcard = raw.findIndex((part) => part === undefined || !/^\d+$/.test(part));
  const given = wildcard === -1 ? 3 : wildcard;
  const low = [0, 1, 2].map((i) => (i < given ? Number(raw[i]) : 0));
  if (given === 0) {
    if (operator === '>' || operator === '<') throw new Error(`unsupported Node range syntax "${text}"`);
    return [ZERO, UNBOUNDED];
  }
  const pastGiven = bump(low, given - 1);
  switch (operator) {
    case '>=':
      return [low, UNBOUNDED];
    case '>':
      return [pastGiven, UNBOUNDED];
    case '<':
      return [ZERO, low];
    case '<=':
      return [ZERO, pastGiven];
    case '~':
      return [low, bump(low, Math.min(given - 1, 1))];
    case '^': {
      const significant = low.findIndex((part) => part !== 0);
      return [low, bump(low, significant === -1 || significant >= given ? given - 1 : significant)];
    }
    default:
      return [low, pastGiven];
  }
}

// A range as sorted, disjoint, non-adjacent intervals, so a contiguous run of versions always sits
// inside a single one.
function parseRange(range) {
  const intervals = range
    .split('||')
    .map((alternative) => {
      const text = alternative.trim().replace(/(\^|~|>=|>|<=|<|=)\s+/g, '$1');
      if (text === '' && range.includes('||')) throw new Error(`unsupported Node range syntax "${range}"`);
      return (text || '*').split(/\s+/).map(comparatorInterval).reduce(
        ([low, high], [nextLow, nextHigh]) => [later(low, nextLow), earlier(high, nextHigh)],
      );
    })
    .filter(([low, high]) => compare(low, high) < 0)
    .sort(([a], [b]) => compare(a, b));
  const merged = [];
  for (const [low, high] of intervals) {
    const last = merged.at(-1);
    if (last && compare(low, last[1]) <= 0) last[1] = later(last[1], high);
    else merged.push([low, high]);
  }
  return merged;
}

function isSubset(inner, outer) {
  return inner.every(([low, high]) =>
    outer.some(([outerLow, outerHigh]) => compare(outerLow, low) <= 0 && compare(high, outerHigh) <= 0),
  );
}

/** Returns one message per fault; an empty list means the declared range holds. */
export function checkNodeEngines({ packageJson, readDependencyManifest }) {
  const declared = packageJson.engines?.node;
  if (typeof declared !== 'string' || declared.trim() === '') return ['package.json declares no engines.node'];
  let admitted;
  try {
    admitted = parseRange(declared);
  } catch (error) {
    return [`package.json engines.node: ${error.message}`];
  }
  const names = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
  return names.flatMap((name) => {
    try {
      const accepted = readDependencyManifest(name).engines?.node;
      if (accepted === undefined || isSubset(admitted, parseRange(accepted))) return [];
      return [`package.json engines.node "${declared}" admits Node versions that ${name} ("${accepted}") does not`];
    } catch (error) {
      return [`${name}: cannot check its engines.node: ${error.message}`];
    }
  });
}

const readJson = (...path) => JSON.parse(readFileSync(join(REPO_ROOT, ...path), 'utf8'));

/** Checks this repository's package.json against its installed direct dependencies. */
export function checkRepoNodeEngines() {
  return checkNodeEngines({
    packageJson: readJson('package.json'),
    readDependencyManifest: (name) => readJson('node_modules', name, 'package.json'),
  });
}
