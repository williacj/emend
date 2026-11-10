// ABOUTME: Selects the test suites a change needs from the ratified changed-path contract.
// ABOUTME: Falls back to all suites on every uncertain result; `npm run scope:tests` is its caller.

export const CLASSIFIER_VERSION = 'suites-v3';
export const ALL_SUITES = Object.freeze(['R', 'T', 'F', 'E']);

const SUITE_NAMES = Object.freeze({
  R: 'Rust',
  T: 'Tooling + matrix',
  F: 'Frontend',
  E: 'E2E acceptance',
});
const CLASSIFIER_PATHS = new Set([
  'scripts/suite-classifier.mjs',
  'scripts/suite-classifier.test.mjs',
]);

function suiteFlags(selected) {
  const chosen = new Set(selected);
  return Object.fromEntries(ALL_SUITES.map((suite) => [suite, chosen.has(suite)]));
}

function result({ selected, reason, matches = [], failClosed = false, baseSha = null, headSha = null }) {
  return {
    version: CLASSIFIER_VERSION,
    suites: suiteFlags(selected),
    reason,
    matches,
    failClosed,
    baseSha,
    headSha,
  };
}

function runAll(reason, options = {}) {
  return result({ selected: ALL_SUITES, reason, ...options });
}

function validUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function normalizePath(rawPath) {
  if (typeof rawPath !== 'string' || !rawPath || /[\u0000-\u001f\u007f]/.test(rawPath) || !validUnicode(rawPath)) {
    throw new Error('changed path is missing or invalid');
  }
  const path = rawPath.replaceAll('\\', '/');
  if (path.startsWith('/') || path.startsWith('./') || path.includes('//')) {
    throw new Error(`changed path is not repository-relative: ${JSON.stringify(rawPath)}`);
  }
  if (path.split('/').some((part) => part === '.' || part === '..' || part === '')) {
    throw new Error(`changed path contains an invalid segment: ${JSON.stringify(rawPath)}`);
  }
  return path;
}

function starts(path, prefix) {
  return path.startsWith(`${prefix}/`);
}

function isRootConfig(path) {
  if (path.includes('/')) return false;
  return /^tsconfig.*\.json$/.test(path)
    || /^vite\.config\..+$/.test(path)
    || /^vitest.*\.config\..+$/.test(path)
    || /^playwright\.config\..+$/.test(path);
}

function ruleOne(path) {
  return starts(path, '.github')
    || CLASSIFIER_PATHS.has(path)
    || ['package.json', 'package-lock.json', 'rust-toolchain.toml', 'src-tauri/Cargo.lock',
      'src-tauri/tauri.conf.json', '.gitattributes', '.gitignore', 'CLAUDE.md'].includes(path)
    || (starts(path, 'src-tauri') && path.endsWith('/Cargo.toml'))
    || isRootConfig(path);
}

function ruleTwo(path) {
  return starts(path, 'src-tauri/src/commands')
    || path === 'src-tauri/src/lib.rs'
    || starts(path, 'src-tauri/capabilities')
    || starts(path, 'src-tauri/gen')
    || starts(path, 'fixtures')
    || starts(path, 'docs/formats/provider-contract')
    || starts(path, 'docs/formats/sidecar');
}

function classifyOne(path) {
  if (starts(path, 'src-tauri')) return { rule: 4, suites: ['R'], reason: 'Rust-owned path' };
  if (starts(path, 'scripts') || starts(path, '.claude') || starts(path, '.agents')
      || ['docs/test-matrix.md', 'docs/functional-spec.md', 'docs/tech-design.md',
        'docs/ux-design.md', 'docs/test-plan.md'].includes(path)) {
    return { rule: 6, suites: ['T'], reason: 'tooling or owning-spec path' };
  }
  if (starts(path, 'src') || starts(path, 'tests') || starts(path, 'e2e')
      || path === 'index.html' || starts(path, 'public')) {
    return { rule: 7, suites: ['F', 'E'], reason: 'frontend app-wiring or e2e path' };
  }
  if (starts(path, 'docs') || path === 'README.md' || starts(path, 'site') || starts(path, 'spikes')) {
    return { rule: 8, suites: ['T'], reason: 'documentation or non-shipping artifact' };
  }
  return { rule: 9, suites: ALL_SUITES, reason: 'unknown path defaults to run all', failClosed: true };
}

export function classifyChangedPaths(rawPaths, { baseSha = null, headSha = null } = {}) {
  let paths;
  try {
    if (!Array.isArray(rawPaths)) throw new Error('changed paths are not an array');
    paths = rawPaths.map(normalizePath);
  } catch (error) {
    return runAll(`uncertain changed paths: ${error.message}`, { failClosed: true, baseSha, headSha });
  }
  if (!paths.length) {
    return runAll('empty changed-path result defaults to run all', { failClosed: true, baseSha, headSha });
  }

  for (const path of paths) {
    if (ruleOne(path)) {
      return runAll(`rule 1: workflow, dependency, toolchain, classifier, or governing path (${path})`, {
        matches: [{ path, rule: 1, suites: ALL_SUITES }], baseSha, headSha,
      });
    }
    if (ruleTwo(path)) {
      return runAll(`rule 2: shared interface path (${path})`, {
        matches: [{ path, rule: 2, suites: ALL_SUITES }], baseSha, headSha,
      });
    }
  }

  const hasRust = paths.some((path) => starts(path, 'src-tauri'));
  const hasFrontend = paths.some((path) => starts(path, 'src') || starts(path, 'tests') || starts(path, 'e2e'));
  if (hasRust && hasFrontend) {
    return runAll('rule 3: combined Rust and frontend change', {
      matches: [{ path: '(cross-layer diff)', rule: 3, suites: ALL_SUITES }], baseSha, headSha,
    });
  }

  const selected = new Set();
  const matches = [];
  for (const path of paths) {
    const match = classifyOne(path);
    matches.push({ path, ...match });
    if (match.rule === 9) {
      return runAll(`rule 9: unknown path defaults to run all (${path})`, {
        matches, failClosed: true, baseSha, headSha,
      });
    }
    for (const suite of match.suites) selected.add(suite);
  }
  return result({
    selected: ALL_SUITES.filter((suite) => selected.has(suite)),
    reason: 'path-table union',
    matches,
    baseSha,
    headSha,
  });
}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

export function parseNameOnlyDiff(output) {
  if (!Buffer.isBuffer(output)) throw new Error('git diff output is not a byte buffer');
  if (!output.length) return [];
  const decoded = decodeUtf8(output, 'git diff output');
  if (!decoded.endsWith('\0')) throw new Error('git diff output is missing NUL framing');
  const paths = decoded.slice(0, -1).split('\0');
  if (paths.some((path) => !path)) throw new Error('git diff output contains an empty path');
  return paths;
}

function suiteReason(classification, suite) {
  const matching = classification.matches
    .filter((match) => match.suites.includes(suite))
    .map((match) => `rule ${match.rule}: ${match.path}`);
  return matching.length
    ? matching.join('; ')
    : (classification.suites[suite]
      ? classification.reason
      : `no changed path matched a rule selecting ${suite}`);
}

export function renderClassificationSummary(classification) {
  const lines = [
    '## Suite classification',
    '',
    `- Classifier: \`${classification.version}\``,
    `- Base SHA: ${classification.baseSha ? `\`${classification.baseSha}\`` : 'not applicable'}`,
    `- Head SHA: ${classification.headSha ? `\`${classification.headSha}\`` : 'not applicable'}`,
    `- Decision: ${classification.reason}`,
    '',
    '| Key | Suite | Disposition | Reason |',
    '| --- | --- | --- | --- |',
    ...ALL_SUITES.map((suite) => {
      const disposition = classification.suites[suite] ? 'selected' : 'inapplicable';
      return `| ${suite} | ${SUITE_NAMES[suite]} | ${disposition} | ${suiteReason(classification, suite).replaceAll('|', '\\|')} |`;
    }),
    '',
  ];
  return lines.join('\n');
}
