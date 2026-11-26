// ABOUTME: Guards the shipped app icon set: every bundled icon exists, none is still the pre-rename
// ABOUTME: icon, and the small Windows frames are the designer's drawings from docs/design/icons/.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readIcoFrames } from './generate-app-icons.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TAURI = join(ROOT, 'src-tauri');
const bundleIcons = JSON.parse(readFileSync(join(TAURI, 'tauri.conf.json'), 'utf8')).bundle.icon;

// Git blob ids of the pre-rename icon set; `git ls-tree f50e1aa src-tauri/icons/` lists them.
const PRE_RENAME_BLOBS = {
  '128x128.png': '6be5e50e9b9ae84d9e2ee433f32ef446495eaf3b',
  '128x128@2x.png': 'e81becee571e96f76aa5667f9324c05e5e7a4479',
  '32x32.png': 'a437dd51741e9e56e14b5d6024493cb2abfd5259',
  'Square107x107Logo.png': '0ca4f27198838968bd60ed7d371bfa23496b7fe5',
  'Square142x142Logo.png': 'b81f820394d1504ff4b4091473a8263542c9edc4',
  'Square150x150Logo.png': '624c7bfba0498dcebbc8a020fe06f08cfff2384a',
  'Square284x284Logo.png': 'c021d2ba76619c08969ab688db3b27f29257aa6f',
  'Square30x30Logo.png': '621970023096ed9f494ba18ace15421a45cd65fa',
  'Square310x310Logo.png': 'f9bc04839491e66c07b16ab03743c0c53b4109cc',
  'Square44x44Logo.png': 'd5fbfb2ab4e57e8a75620cded43bddc1a15daa99',
  'Square71x71Logo.png': '63440d7984936a9caa89275928d8dce97e4d033b',
  'Square89x89Logo.png': 'f3f705af2f2e044682ac042b37dba6682a0c8a6b',
  'StoreLogo.png': '455638826192851ad1ae604d66f2ca352979442c',
  'icon.icns': '12a5bcee268851fdab744ec4a31f75d3d008e031',
  'icon.ico': 'b3636e4b22ba65db9061cd60a77b02c92022dfd6',
  'icon.png': 'e1cd2619e0b5ec089cbba5ec7b03ddf2b1dfceb6',
};

function gitBlobId(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

test('every bundle.icon path exists and is covered by the pre-rename comparison', () => {
  assert.ok(bundleIcons.length > 0, 'bundle.icon lists no icons');
  for (const path of bundleIcons) {
    assert.ok(existsSync(join(TAURI, path)), `bundle.icon lists a missing file: ${path}`);
    assert.ok(Object.hasOwn(PRE_RENAME_BLOBS, path.replace(/^icons\//, '')), `no pre-rename hash for ${path}`);
  }
});

test('no shipped icon is missing or byte-identical to the pre-rename icon it replaces', () => {
  for (const [name, preRenameBlob] of Object.entries(PRE_RENAME_BLOBS)) {
    const path = join(TAURI, 'icons', name);
    assert.ok(existsSync(path), `missing icon: ${name}`);
    assert.notEqual(gitBlobId(readFileSync(path)), preRenameBlob, `${name} is still the pre-rename icon`);
  }
});

test("icon.ico's 16px and 32px frames are the designer's small-size drawings", () => {
  const frames = readIcoFrames(readFileSync(join(TAURI, 'icons', 'icon.ico')));
  for (const size of [16, 32]) {
    const matching = frames.filter((frame) => frame.width === size);
    assert.equal(matching.length, 1, `expected one ${size}px frame`);
    const master = readFileSync(join(ROOT, 'docs', 'design', 'icons', `emend-glyph-${size}.png`));
    assert.ok(matching[0].data.equals(master), `${size}px frame differs from emend-glyph-${size}.png`);
  }
});
