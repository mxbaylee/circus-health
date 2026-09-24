import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { renderBrandPng } from '../scripts/brand-raster.ts';

const SOURCE_ROOT = join(import.meta.dirname, '..');
const FOLD_GEOMETRY = 'M16 28C17 34 24 36 30 40M45 28C43 34 36 36 30 40M30 20V40';

function paletteHighlight(tokens: string, selector: string): string {
  const start = tokens.indexOf(selector);
  assert.notEqual(start, -1);
  const block = tokens.slice(tokens.indexOf('{', start), tokens.indexOf('}', start));
  const highlight = block.match(/--brand-highlight:\s*(#[0-9a-f]{6})/i)?.[1];
  assert.ok(highlight);
  return highlight.toLowerCase();
}

function withoutFold(svg: string): string {
  return svg.replace(new RegExp(`<path d="${FOLD_GEOMETRY}"[^>]*/>`), '');
}

async function pixels(svgOrPng: string | Buffer, size: number): Promise<Buffer> {
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  const image = await loadImage(
    typeof svgOrPng === 'string' ? await renderBrandPng(svgOrPng, size) : svgOrPng,
  );
  context.drawImage(image, 0, 0, size, size);
  return Buffer.from(context.getImageData(0, 0, size, size).data);
}

function icoFrames(ico: Buffer): Map<number, Buffer> {
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const frames = new Map<number, Buffer>();
  for (let index = 0; index < ico.readUInt16LE(4); index += 1) {
    const entry = 6 + index * 16;
    const size = ico.readUInt8(entry) || 256;
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    frames.set(size, ico.subarray(offset, offset + length));
  }
  return frames;
}

test('canonical and generated theme marks retain the fold geometry', async () => {
  const [canonical, tokens, dark, light] = await Promise.all([
    readFile(join(SOURCE_ROOT, 'assets/brand/logo.svg'), 'utf8'),
    readFile(join(SOURCE_ROOT, 'app/tokens.css'), 'utf8'),
    readFile(join(SOURCE_ROOT, 'public/favicon-dark.svg'), 'utf8'),
    readFile(join(SOURCE_ROOT, 'public/favicon-light.svg'), 'utf8'),
  ]);

  assert.match(canonical, new RegExp(`d="${FOLD_GEOMETRY}"`));
  assert.match(canonical, /stroke="var\(--brand-highlight\)"/);
  assert.doesNotMatch(canonical, /data-tiny=/);
  for (const [selector, svg] of [
    [":root[data-theme='dark']", dark],
    [":root[data-theme='light']", light],
  ] as const) {
    assert.match(svg, new RegExp(`d="${FOLD_GEOMETRY}"`));
    assert.match(svg, new RegExp(`stroke="${paletteHighlight(tokens, selector)}"`, 'i'));
    for (const size of [16, 32]) {
      assert.notDeepEqual(await pixels(svg, size), await pixels(withoutFold(svg), size));
    }
  }
});

test('the ICO contains visible fold geometry at 16 and 32 pixels', async () => {
  const [ico, dark] = await Promise.all([
    readFile(join(SOURCE_ROOT, 'public/favicon.ico')),
    readFile(join(SOURCE_ROOT, 'public/favicon-dark.svg'), 'utf8'),
  ]);
  const frames = icoFrames(ico);
  assert.deepEqual([...frames.keys()], [16, 32, 48]);

  for (const size of [16, 32]) {
    const frame = frames.get(size);
    assert.ok(frame);
    assert.deepEqual(await pixels(frame, size), await pixels(dark, size));
    assert.notDeepEqual(await pixels(frame, size), await pixels(withoutFold(dark), size));
  }
});

test('brand:check rejects missing, changed and out-of-date assets without rewriting them', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'circus-brand-check-'));
  const source = join(temporary, 'src');
  const files = [
    'scripts/generate-brand-assets.ts',
    'scripts/brand-raster.ts',
    'assets/brand/logo.svg',
    'app/tokens.css',
    'app/components/BrandMark.generated.tsx',
    ...[
      'logo.svg',
      'favicon.svg',
      'favicon-dark.svg',
      'favicon-light.svg',
      'favicon.ico',
      'apple-touch-icon.png',
      'icon-192.png',
      'icon-512.png',
      'site.webmanifest',
    ].map((name) => `public/${name}`),
  ];
  const check = () =>
    spawnSync(process.execPath, ['scripts/generate-brand-assets.ts', '--check'], {
      cwd: source,
      encoding: 'utf8',
      timeout: 30_000,
    });

  try {
    await Promise.all(
      files.map(async (file) => {
        await mkdir(dirname(join(source, file)), { recursive: true });
        await copyFile(join(SOURCE_ROOT, file), join(source, file));
      }),
    );
    await copyFile(join(SOURCE_ROOT, '../.prettierrc.json'), join(temporary, '.prettierrc.json'));
    await copyFile(join(SOURCE_ROOT, '../package.json'), join(temporary, 'package.json'));
    await symlink(
      join(SOURCE_ROOT, '../node_modules'),
      join(temporary, 'node_modules'),
      'junction',
    );
    const baseline = check();
    assert.equal(baseline.status, 0, baseline.stderr);

    const pngPath = join(source, 'public/icon-192.png');
    const png = await readFile(pngPath);
    const corrupted = Buffer.from(png);
    corrupted[corrupted.length - 1] ^= 1;
    await writeFile(pngPath, corrupted);
    const changed = check();
    assert.equal(changed.status, 1, changed.stderr);
    assert.match(changed.stderr, /public\/icon-192\.png/);
    assert.deepEqual(await readFile(pngPath), corrupted, 'check must not repair changed files');
    await writeFile(pngPath, png);

    const icoPath = join(source, 'public/favicon.ico');
    await rm(icoPath);
    const missing = check();
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /public\/favicon\.ico/);
    await assert.rejects(readFile(icoPath), { code: 'ENOENT' });
    await copyFile(join(SOURCE_ROOT, 'public/favicon.ico'), icoPath);

    const logoPath = join(source, 'assets/brand/logo.svg');
    const logo = await readFile(logoPath, 'utf8');
    assert.notEqual(withoutFold(logo), logo);
    await writeFile(logoPath, withoutFold(logo));
    const stale = check();
    assert.equal(stale.status, 1, stale.stderr);
    assert.match(stale.stderr, /app\/components\/BrandMark\.generated\.tsx/);
    assert.match(stale.stderr, /public\/favicon\.ico/);
    assert.match(stale.stderr, /public\/icon-192\.png/);
    assert.deepEqual(await readFile(pngPath), png, 'check must leave stale exports for review');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
