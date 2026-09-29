import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { writeFictionalBenchmarkPdf } from './fictional-pdf-benchmark-fixture.ts';

test('mixed benchmark fixture has dense native text/vectors and genuine raster-only pages, with explicit padding', async (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'fictional-benchmark-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = resolve(directory, 'fictional.pdf');
  const fixture = writeFictionalBenchmarkPdf(path, 2, 'mixed', 2 * 1024 * 1024);
  const bytes = readFileSync(path);
  assert.equal(bytes.length, 2 * 1024 * 1024);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.sourceHash);
  assert.ok(fixture.paddingBytes > 0);
  assert.ok(fixture.embeddedJpegBytes > 100_000);
  const task = getDocument({
    data: Uint8Array.from(bytes),
    standardFontDataUrl: fileURLToPath(
      new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url),
    ),
  });
  try {
    const document = await task.promise;
    assert.equal(document.numPages, 2);
    const dense = await document.getPage(1),
      scan = await document.getPage(2);
    const denseText = (await dense.getTextContent()).items
      .flatMap((item) => ('str' in item ? [item.str] : []))
      .join(' ');
    assert.match(denseText, /FICTIONAL BENCHMARK - page 1 of 2/);
    assert.ok(denseText.length > 4_000);
    assert.equal(
      (await scan.getTextContent()).items.length,
      0,
      'scan pages must not hide OCR text',
    );
    assert.ok(
      (await scan.getOperatorList()).fnArray.includes(OPS.paintImageXObject),
      'scan page must actually paint its image',
    );
    assert.ok(
      (await dense.getOperatorList()).fnArray.includes(OPS.constructPath),
      'dense page must contain vector drawing',
    );
  } finally {
    await task.destroy();
  }
});

test('paired benchmark exercises both formats on identical mixed source and keeps absent timings unknown', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [fileURLToPath(new URL('./benchmark-intake-pdf.ts', import.meta.url))],
    {
      env: {
        ...process.env,
        CRS_PDF_BENCHMARK_PAGES: '2',
        CRS_PDF_BENCHMARK_BYTES: '0',
        CRS_PDF_BENCHMARK_FIXTURE: 'mixed',
        CRS_PDF_BENCHMARK_FORMAT: 'both',
        CRS_PDF_BENCHMARK_ORDER: 'pdf,image',
        CRS_PDF_BENCHMARK_READ_ALL: '1',
        CRS_PDF_BENCHMARK_KEEP: '0',
      },
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const report = JSON.parse(stdout);
  assert.equal(report.format, 'circus-fictional-pdf-benchmark-v2');
  assert.equal(report.fixture.paddingBytes, 0);
  assert.deepEqual(report.formatOrder, ['pdf', 'image']);
  const [native, raster] = report.runs;
  assert.equal(native.nativePages, 2);
  assert.equal(native.fallbackPages, 0);
  assert.equal(native.phases.nativePdfMs.count, 2);
  assert.equal(native.phases.renderMs.count, 0);
  assert.equal(native.phases.renderMs.mean, null);
  assert.equal(raster.phases.renderMs.count, 2);
  assert.equal(raster.phases.nativePdfMs.count, 0);
  for (const run of report.runs) {
    assert.equal(run.pageReads.length, 2);
    assert.deepEqual(
      run.pageReads.map((read: { kind: string }) => read.kind),
      ['dense', 'scan'],
    );
    assert.ok(run.parser.sessionsCreated >= 1, 'each format must get a fresh worker');
    assert.equal(Object.values(run.checks).every(Boolean), true);
  }
});
