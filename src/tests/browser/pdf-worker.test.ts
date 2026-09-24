import { createTestRuntimeDirectory } from '../../server/test/runtime-fixture.ts';
import type { Browser } from 'playwright';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startRuntime } from '../../server/runtime.ts';

test('encrypted runtime loads the PDF module worker and renders a fictional PDF', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'circus-pdf-worker-'));
  const dist = join(root, 'src/dist');
  mkdirSync(dist, { recursive: true });
  mkdirSync(join(root, 'data'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Fictional PDF test</title>');
  for (const name of ['pdf.mjs', 'pdf.worker.min.mjs']) {
    copyFileSync(
      fileURLToPath(import.meta.resolve(`pdfjs-dist/legacy/build/${name}`)),
      join(dist, name === 'pdf.mjs' ? 'pdf.js' : name),
    );
  }
  const runtimeDirectory = createTestRuntimeDirectory();
  const runtime = await startRuntime({
    codeRoot: root,
    dataDirectory: join(root, 'data'),
    runtimeDirectory,
    port: 0,
    host: '127.0.0.1',
  });
  let browser: Browser | undefined;
  t.after(async () => {
    await browser?.close();
    await runtime.close();
    rmSync(runtimeDirectory, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  await page.goto(`http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`);
  const result = await page.evaluate(async () => {
    const moduleUrl = '/pdf.js';
    const pdfjs = (await import(moduleUrl)) as typeof import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    const stream = '0 0 0 rg 10 10 80 80 re f';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    objects.forEach((object, i) => {
      offsets.push(pdf.length);
      pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const task = pdfjs.getDocument({
      data: new TextEncoder().encode(pdf),
      enableXfa: false,
      useWorkerFetch: false,
    });
    const document = await task.promise;
    const pdfPage = await document.getPage(1);
    const canvas = window.document.createElement('canvas');
    canvas.width = canvas.height = 100;
    const context = canvas.getContext('2d')!;
    await pdfPage.render({
      canvas,
      canvasContext: context,
      viewport: pdfPage.getViewport({ scale: 1 }),
    }).promise;
    const pixel = Array.from(context.getImageData(50, 50, 1, 1).data);
    const pages = document.numPages;
    await task.destroy();
    return { pixel, pages };
  });
  assert.deepEqual(result, { pixel: [0, 0, 0, 255], pages: 1 });
  assert.equal(workers.length, 1, 'PDF must render with a real worker');
  assert.match(workers[0], /\/pdf\.worker\.min\.mjs$/);
});
