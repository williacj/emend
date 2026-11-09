// ABOUTME: Validates hostname artifacts for co-located Windows Actions canary and benchmark cohorts.
// ABOUTME: Compares hostnames rather than runner names or workspace paths and fails closed on gaps.

import { appendFileSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function parseExpected(value) {
  if (!/^[1-9][0-9]*$/.test(value ?? '')) {
    throw new Error('expected hostname evidence count must be a canonical positive integer');
  }
  return Number(value);
}

function readHostname(path) {
  const text = readFileSync(path, 'utf8');
  const singleLine = text.replace(/\r\n/g, '\n').replace(/\n$/, '');
  const normalized = singleLine.trim();
  if (!normalized || normalized !== singleLine || normalized.includes('\n')) {
    throw new Error(`${basename(path)} must contain exactly one non-empty line`);
  }
  return normalized.toUpperCase();
}

export function inspectHostCohort(paths, expected) {
  if (!Number.isInteger(expected) || expected < 1) {
    throw new Error('expected hostname evidence count must be a positive integer');
  }
  if (paths.length !== expected) {
    throw new Error(`expected ${expected} hostname evidence files; found ${paths.length}`);
  }
  const resolvedPaths = paths.map((path) => resolve(path).toLowerCase());
  if (new Set(resolvedPaths).size !== paths.length) {
    throw new Error('hostname evidence files must be distinct');
  }
  const hostnames = paths.map(readHostname);
  const distinct = [...new Set(hostnames)].sort();
  if (distinct.length !== 1) {
    throw new Error(`hostname evidence must identify one physical host; found ${distinct.join(', ')}`);
  }
  return {
    hostname: distinct[0],
    evidenceFiles: paths.map((path) => basename(path)).sort(),
  };
}

function main() {
  const expected = parseExpected(process.argv[2]);
  const result = inspectHostCohort(process.argv.slice(3), expected);
  const markdown = [
    '## Windows host cohort',
    '',
    `Validated ${expected} hostname evidence file(s) on physical host \`${result.hostname}\`.`,
    '',
  ].join('\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  process.stdout.write(markdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
