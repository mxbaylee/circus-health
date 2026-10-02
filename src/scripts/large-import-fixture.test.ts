import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  createLargeImportOracle,
  largeImportPage,
  renderLargeImportPage,
  writeLargeImportFixture,
  type LargeImportOracle,
} from './large-import-fixture.ts';
import { assertFictionalOutputPath, writeFictionalPdf } from './fictional-pdf-writer.ts';

function directory(t: test.TestContext) {
  const path = mkdtempSync(join(tmpdir(), 'fictional-large-import-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const pdf = (path: string) =>
  getDocument({
    data: Uint8Array.from(readFileSync(path)),
    standardFontDataUrl: fileURLToPath(
      new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url),
    ),
  });

test('scanned columns remain aligned across narrow and wide glyphs', async () => {
  const oracle = createLargeImportOracle();
  const tableLines = [149, 150].flatMap((page) =>
    largeImportPage(oracle, page).lines.filter((line) => line.includes('|')),
  );
  assert.equal(tableLines.length, 6);
  for (const line of tableLines)
    assert.deepEqual(
      [...line.matchAll(/\|/g)].map((match) => match.index),
      [17, 27, 36],
    );
  const rendered = renderLargeImportPage({
    ...largeImportPage(createLargeImportOracle(), 2),
    lines: ['iiiiiiii         |', 'WWWWWWWW         |'],
  });
  assert.ok(rendered.image);
  const image = await loadImage(rendered.image.bytes);
  const canvas = createCanvas(image.width, image.height);
  try {
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const rightEdges = [60, 108].map((top) => {
      const { data } = context.getImageData(0, top, canvas.width, 26);
      let right = -1;
      for (let row = 0; row < 26; row++)
        for (let column = 0; column < canvas.width; column++)
          // Thin JPEG-encoded separators can be antialiased above the body-text threshold.
          if (data[(row * canvas.width + column) * 4]! < 200) right = Math.max(right, column);
      return right;
    });
    assert.ok(rightEdges.every((edge) => edge >= 264 && edge < 276));
    assert.ok(Math.abs(rightEdges[0]! - rightEdges[1]!) <= 1);
  } finally {
    canvas.width = canvas.height = 1;
  }
});

test('900-page fictional PDF and oracle contain supported literal facts with two owners and genuine scanned pages', async (t) => {
  const root = directory(t),
    pdfPath = join(root, 'fixture.pdf'),
    oraclePath = join(root, 'oracle.json');
  const receipt = writeLargeImportFixture(pdfPath, oraclePath);
  const oracle = JSON.parse(readFileSync(oraclePath, 'utf8')) as LargeImportOracle;
  assert.equal(oracle.format, 'circus-fictional-large-import-oracle-v1');
  assert.equal(receipt.pages, 900);
  assert.equal(receipt.nativePages, 450);
  assert.equal(receipt.scanPages, 450);
  assert.equal(receipt.expectedRecords, 901);
  assert.equal(receipt.paddingBytes, 0);
  assert.equal(receipt.bytes, statSync(pdfPath).size);
  assert.equal(
    receipt.sourceHash,
    createHash('sha256').update(readFileSync(pdfPath)).digest('hex'),
  );
  assert.ok(receipt.maxPagePayloadBytes < 1024 * 1024);
  for (const path of [pdfPath, oraclePath]) assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(oracle.reports.length, 6);
  assert.equal(new Set(oracle.assertions.map((item) => item.key)).size, 901);
  assert.equal(new Set(oracle.assertions.map((item) => item.personKey)).size, 2);
  assert.deepEqual([...new Set(oracle.assertions.map((item) => item.mapping.kind))].sort(), [
    'medication',
    'observation',
    'procedure',
  ]);
  for (const report of oracle.reports) {
    assert.equal(report.lastPage - report.firstPage + 1, 150);
    assert.equal(new Date(report.date).toISOString().slice(0, 10), report.date);
  }
  for (const item of oracle.assertions) {
    assert.equal('personId' in item.mapping, false);
    assert.equal('subject' in item.mapping, false);
    assert.equal('code' in item.mapping, false);
    assert.deepEqual(Object.keys(item.origins).sort(), Object.keys(item.mapping).sort());
    for (const origin of Object.values(item.origins)) {
      assert.ok(
        largeImportPage(oracle, origin.page).lines.some((line) => line.includes(origin.literal)),
      );
      const report = oracle.reports.find((report) => report.key === item.reportKey)!;
      assert.equal(report.personKey, item.personKey);
      assert.ok(origin.page >= report.firstPage && origin.page <= report.lastPage);
    }
  }
  const task = pdf(pdfPath);
  try {
    const document = await task.promise;
    assert.equal(document.numPages, 900);
    for (const number of [1, 149, 151, 301, 451, 601, 751, 899]) {
      const page = await document.getPage(number);
      const text = (await page.getTextContent()).items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join('\n');
      const description = largeImportPage(oracle, number);
      // PDF.js splits intentional column spaces into separate items. Compare glyph order;
      // literal signs/precision remain unchanged, and oracle value checks stay exact below.
      for (const line of description.lines.filter(Boolean))
        assert.ok(
          text.replace(/\s+/g, ' ').includes(line.replace(/\s+/g, ' ')),
          `page ${number}: ${line}`,
        );
    }
    for (const number of [2, 150, 300, 452, 752, 900]) {
      const page = await document.getPage(number);
      assert.equal((await page.getTextContent()).items.length, 0);
      assert.ok((await page.getOperatorList()).fnArray.includes(OPS.paintImageXObject));
    }
    // Render both sides of the split row and later owner/report pages; optionally retain only PNGs.
    for (const number of [149, 150, 301, 900]) {
      const page = await document.getPage(number),
        viewport = page.getViewport({ scale: 1.5 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        const context = canvas.getContext('2d');
        await page.render({ canvas, canvasContext: context, viewport } as unknown as Parameters<
          typeof page.render
        >[0]).promise;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let darkPixels = 0;
        for (let index = 0; index < pixels.length; index += 4)
          if (pixels[index]! < 80) darkPixels++;
        assert.ok(darkPixels > 1000, `page ${number} paints visible text`);
        const output = process.env.CRS_LARGE_FIXTURE_RENDER_DIR;
        if (output) {
          const path = join(output, `fictional-page-${number}.png`);
          assertFictionalOutputPath(path);
          writeFileSync(path, canvas.toBuffer('image/png'), { flag: 'wx', mode: 0o600 });
        }
      } finally {
        canvas.width = canvas.height = 1;
      }
    }
  } finally {
    await task.destroy();
  }
});

test('split table row has distinct field origins and both halves survive a native-only inspection', async (t) => {
  const root = directory(t),
    oracle = createLargeImportOracle();
  const row = oracle.assertions.find((item) => item.key === 'fictional-split-row')!;
  assert.deepEqual(row.pages, [149, 150]);
  assert.equal(row.origins.testLabel!.page, 149);
  assert.equal(row.origins.valueText!.page, 150);
  const first = largeImportPage(oracle, 149),
    second = largeImportPage(oracle, 150);
  assert.ok(first.lines.join('\n').includes('FX-CROSS-001'));
  assert.equal(first.lines.join('\n').includes('<0.0030'), false);
  assert.ok(second.lines.join('\n').includes('<0.0030'));
  assert.equal(second.lines.join('\n').includes('FX-CROSS-001'), false);
  const path = join(root, 'split.pdf');
  writeFictionalPdf(path, {
    pages: 2,
    pageAt: (page) => renderLargeImportPage(page === 1 ? first : second, true),
  });
  const task = pdf(path);
  try {
    const document = await task.promise;
    for (const [field, origin] of Object.entries(row.origins)) {
      const page = await document.getPage(origin.page === 149 ? 1 : 2);
      const text = (await page.getTextContent()).items
        .flatMap((item) => ('str' in item ? [item.str] : []))
        .join('\n');
      assert.ok(text.includes(origin.literal), field);
    }
  } finally {
    await task.destroy();
  }
});

test('private exclusive outputs preserve conflicts and remove only this call partial artifacts', (t) => {
  const root = directory(t),
    pdfPath = join(root, 'fixture.pdf'),
    oraclePath = join(root, 'oracle.json');
  writeFileSync(pdfPath, 'preexisting');
  assert.throws(() => writeLargeImportFixture(pdfPath, oraclePath), /EEXIST/);
  assert.equal(readFileSync(pdfPath, 'utf8'), 'preexisting');
  assert.equal(existsSync(oraclePath), false);
  writeFileSync(oraclePath, 'preexisting oracle');
  assert.throws(() => writeLargeImportFixture(join(root, 'other.pdf'), oraclePath), /EEXIST/);
  assert.equal(existsSync(join(root, 'other.pdf')), false);
  assert.equal(readFileSync(oraclePath, 'utf8'), 'preexisting oracle');
  const partial = join(root, 'partial.pdf');
  assert.throws(
    () =>
      writeFictionalPdf(partial, {
        pages: 3,
        pageAt(page) {
          if (page === 2) throw Error('Fictional generation failure');
          return { content: Buffer.from('') };
        },
      }),
    /generation failure/,
  );
  assert.equal(existsSync(partial), false);
  assert.throws(
    () => writeFictionalPdf(partial, { pages: 0, pageAt: () => ({ content: Buffer.from('') }) }),
    /bounds/,
  );
  assert.equal(existsSync(partial), false);
  const repository = join(root, 'git-checkout');
  mkdirSync(repository);
  mkdirSync(join(repository, '.git'));
  assert.throws(
    () => writeLargeImportFixture(join(repository, 'fixture.pdf'), oraclePath),
    /outside Git/,
  );
  const alias = join(root, 'alias');
  symlinkSync(repository, alias);
  assert.throws(() => assertFictionalOutputPath(join(alias, 'fixture.pdf')), /outside Git/);
  assert.throws(
    () =>
      renderLargeImportPage({
        ...largeImportPage(createLargeImportOracle(), 1),
        lines: ['x'.repeat(1000)],
      }),
    /visible page bounds/,
  );
});
