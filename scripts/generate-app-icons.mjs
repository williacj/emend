// ABOUTME: Builds src-tauri/icons/ from the design masters in docs/design/icons/ with `tauri icon`.
// ABOUTME: macOS files come from the macOS master; Windows files come from the unpadded glyph.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntrypoint, resolveTauriCli } from './rust-launcher.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MASTERS = join(ROOT, 'docs', 'design', 'icons');
const ICONS = join(ROOT, 'src-tauri', 'icons');

const MACOS_FILES = ['32x32.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.icns'];
const WINDOWS_TILES = [
  ...[30, 44, 71, 89, 107, 142, 150, 284, 310].map((size) => `Square${size}x${size}Logo.png`),
  'StoreLogo.png',
];
// Sizes the designer drew as PNGs; the 16px one is snapped to whole pixels.
const DRAWN_ICO_FRAMES = { 16: 'emend-glyph-16.png', 32: 'emend-glyph-32.png' };

const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;

export function readIcoFrames(ico) {
  return Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
    const at = ICO_HEADER_BYTES + index * ICO_ENTRY_BYTES;
    const length = ico.readUInt32LE(at + 8);
    const offset = ico.readUInt32LE(at + 12);
    return {
      width: ico.readUInt8(at) || 256,
      // Width, height, colour count, reserved, planes and bit depth.
      description: ico.subarray(at, at + 8),
      data: ico.subarray(offset, offset + length),
    };
  });
}

// Frame order is preserved: Tauri takes the first frame as its default window icon.
function writeIco(frames) {
  const directory = Buffer.alloc(ICO_HEADER_BYTES + frames.length * ICO_ENTRY_BYTES);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(frames.length, 4);
  let offset = directory.length;
  frames.forEach((frame, index) => {
    const at = ICO_HEADER_BYTES + index * ICO_ENTRY_BYTES;
    frame.description.copy(directory, at);
    directory.writeUInt32LE(frame.data.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += frame.data.length;
  });
  return Buffer.concat([directory, ...frames.map((frame) => frame.data)]);
}

// A PNG's IHDR holds width, height, bit depth and colour type (6 is RGBA) at fixed offsets.
function readDrawnFrame(size) {
  const name = DRAWN_ICO_FRAMES[size];
  const data = readFileSync(join(MASTERS, name));
  const [width, height, depth, colourType] = [
    data.readUInt32BE(16), data.readUInt32BE(20), data.readUInt8(24), data.readUInt8(25),
  ];
  if (width !== size || height !== size || depth !== 8 || colourType !== 6) {
    throw new Error(`${name} must be a ${size}px 8-bit RGBA PNG to be an ico frame`);
  }
  return data;
}

function replaceDrawnFrames(ico) {
  const frames = readIcoFrames(ico);
  for (const size of Object.keys(DRAWN_ICO_FRAMES).map(Number)) {
    const frame = frames.find((candidate) => candidate.width === size);
    if (!frame) throw new Error(`tauri icon produced no ${size}px ico frame`);
    frame.data = readDrawnFrame(size);
  }
  return writeIco(frames);
}

function runTauriIcon(master, output) {
  const result = spawnSync(
    process.execPath,
    [resolveTauriCli(), 'icon', join(MASTERS, master), '--output', output],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error(`tauri icon failed for ${master}`);
}

function generate() {
  // `tauri icon` also emits mobile and extra sizes, so it writes to a scratch directory.
  const scratch = mkdtempSync(join(tmpdir(), 'emend-icons-'));
  try {
    const macos = join(scratch, 'macos');
    const windows = join(scratch, 'windows');
    runTauriIcon('emend-macos-1024.png', macos);
    runTauriIcon('emend-glyph.svg', windows);
    for (const name of MACOS_FILES) copyFileSync(join(macos, name), join(ICONS, name));
    for (const name of WINDOWS_TILES) copyFileSync(join(windows, name), join(ICONS, name));
    writeFileSync(join(ICONS, 'icon.ico'), replaceDrawnFrames(readFileSync(join(windows, 'icon.ico'))));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isEntrypoint(import.meta.url)) generate();
