import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomFillSync } from 'node:crypto';
import { disposePdfEvidenceSessions, readPdfEvidencePage } from '../intake-pdf-session.ts';
import { INTAKE_PDF_BOUNDS } from '../intake-files.ts';

// The PDF child session and its queue are process-global, so every test here has to
// retire the session it created; the temporary fixture directory goes with it.
function fixtureDirectory(t: TestContext, prefix: string): string {
  const directory = mkdtempSync(resolve(tmpdir(), prefix));
  t.after(async () => {
    await disposePdfEvidenceSessions();
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

// Independently fictional content; no real health record text.
function fictionalPdf(text: string): Buffer {
  const body = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R' +
      ' /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const startxref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` + `startxref\n${startxref}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}

/**
 * Two pages whose renders land deliberately on either side of the 10 MiB PNG ceiling,
 * each filled edge to edge with an uncompressible random-noise image so the PNG size
 * is a function of pixel count alone rather than of content.
 *
 * Page 1: a 900pt square page renders at scale 2 to 1800x1800 — exactly
 * `maxRenderPixels` — and noise at that size encodes to about 11 MiB, so it exceeds
 * `maxImageBytes` and forces the reduced-dimension second pass (1400x1400, about 7 MiB).
 * Page 2: a 700pt square page renders at 1400x1400 first time and never retries.
 *
 * So one fixture yields both a two-pass read and a one-pass read whose single encode is
 * the same size as the two-pass read's *second* encode. There is no other way to reach
 * the retry: `maxRenderPixels` caps the first pass, and only incompressible content at
 * that cap clears 10 MiB. Random bytes carry no health content by construction.
 */
function fictionalTwoPassPdf(): Buffer {
  const image = (dimension: number) => {
    const pixels = Buffer.allocUnsafe(dimension * dimension * 3);
    randomFillSync(pixels);
    return pixels;
  };
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let position = 0;
  const push = (value: Buffer | string) => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1');
    parts.push(buffer);
    position += buffer.byteLength;
  };
  const object = (number: number, bodies: (Buffer | string)[]) => {
    offsets[number] = position;
    push(`${number} 0 obj\n`);
    for (const body of bodies) push(body);
    push('\nendobj\n');
  };
  const page = (number: number, points: number, imageObject: number) =>
    object(number, [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${points} ${points} ]` +
        ` /Resources << /XObject << /Im0 ${imageObject} 0 R >> >> /Contents ${imageObject + 1} 0 R >>`,
    ]);
  const imageObject = (number: number, dimension: number) => {
    const pixels = image(dimension);
    object(number, [
      `<< /Type /XObject /Subtype /Image /Width ${dimension} /Height ${dimension}` +
        ` /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${pixels.byteLength} >>\nstream\n`,
      pixels,
      '\nendstream',
    ]);
  };
  const content = (number: number, points: number) => {
    const stream = `q ${points} 0 0 ${points} 0 0 cm /Im0 Do Q`;
    object(number, [`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]);
  };

  push('%PDF-1.4\n');
  object(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  object(2, ['<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>']);
  page(3, 900, 4);
  imageObject(4, 1800);
  content(5, 900);
  page(6, 700, 7);
  imageObject(7, 1400);
  content(8, 700);
  const startxref = position;
  push(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
  for (const offset of offsets.slice(1)) push(`${String(offset).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

function fictionalSource(directory: string, name: string, bytes: Buffer, id: string) {
  const path = resolve(directory, name);
  writeFileSync(path, bytes);
  return {
    profileId: 'fictional-profile',
    id,
    path,
    size: bytes.byteLength,
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
    filename: name,
  };
}

test('a page read reports worker sub-timings that account for the phases inside it', async (t) => {
  const directory = fixtureDirectory(t, 'circus-fictional-timings-');
  const source = fictionalSource(
    directory,
    'fictional-page.pdf',
    fictionalPdf('Fictional Iris Meadow visit summary'),
    'fictional-intake-original',
  );

  const page = await readPdfEvidencePage(source, 1, 0);

  assert.equal(page.mimeType, 'image/png', 'PNG remains the PDF render default');
  assert.equal(Buffer.from(page.image).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(page.timings, 'the page read exposes worker sub-timings');
  for (const key of ['verifyMs', 'textMs', 'renderMs', 'encodeMs', 'annotationMs'] as const) {
    assert.equal(typeof page.timings![key], 'number', `${key} is a number`);
    assert.ok(page.timings![key] >= 0, `${key} is not negative`);
  }
  assert.equal(page.timings!.renderPasses, 1, 'a small page renders once');
  // encode is a strict sub-phase of render, so it can never exceed it.
  assert.ok(
    page.timings!.encodeMs <= page.timings!.renderMs + 1,
    'PNG encoding is counted inside the render phase',
  );
});

test('a two-pass render counts both encodes in encodeMs, not only the retry’s', async (t) => {
  const directory = fixtureDirectory(t, 'circus-fictional-two-pass-');
  const source = fictionalSource(
    directory,
    'fictional-oversized-render.pdf',
    fictionalTwoPassPdf(),
    'fictional-intake-two-pass',
  );

  const retried = await readPdfEvidencePage(source, 1, 0);
  const single = await readPdfEvidencePage(source, 2, 0);

  assert.equal(retried.timings!.renderPasses, 2, 'the oversized page rendered twice');
  assert.ok(
    retried.imageReducedForOutput,
    'the retained render is the reduced-dimension one, so the first PNG was discarded',
  );
  assert.ok(
    retried.image.byteLength <= INTAKE_PDF_BOUNDS.maxImageBytes,
    'the delivered PNG is within the output bound',
  );
  assert.equal(single.timings!.renderPasses, 1, 'the smaller page rendered once');

  // Both reads finish with the same 1400x1400 canvas, so `single.timings.encodeMs` is a
  // live measurement of exactly the work the two-pass read's *second* encode did. The
  // first pass encodes 1800x1800 — 1.65x the pixels and a larger PNG — so a summed
  // encodeMs must clear the single-pass figure by a wide margin. Reporting only the
  // retry's encode (the bug) would make these two roughly equal instead.
  assert.equal(single.width, retried.width, 'both reads deliver the same reduced dimensions');
  assert.ok(
    retried.timings!.encodeMs > single.timings!.encodeMs * 1.5,
    `summed encodeMs ${retried.timings!.encodeMs} must exceed 1.5x the one-pass encode ` +
      `${single.timings!.encodeMs}; an unsummed encodeMs would be about equal to it`,
  );
  // Still a strict sub-phase of render: the sum of two encodes sits inside the span that
  // brackets both render passes.
  assert.ok(
    retried.timings!.encodeMs <= retried.timings!.renderMs + 1,
    'both encodes are counted inside the render phase that contains them',
  );
});

test('a page read reports the host-side queue wait separately from worker time', async (t) => {
  const directory = fixtureDirectory(t, 'circus-fictional-queue-');
  const source = fictionalSource(
    directory,
    'fictional-queued.pdf',
    fictionalPdf('Fictional Rowan Alder intake note'),
    'fictional-intake-queued',
  );

  // Two concurrent reads: the PDF child session and its queue are process-global,
  // so the second necessarily waits behind the first.
  const [first, second] = await Promise.all([
    readPdfEvidencePage(source, 1, 0),
    readPdfEvidencePage(source, 1, 0),
  ]);

  assert.equal(typeof first.queueWaitMs, 'number');
  assert.equal(typeof second.queueWaitMs, 'number');
  assert.ok(
    Math.max(first.queueWaitMs, second.queueWaitMs) > 0,
    'the serialized read records a non-zero queue wait',
  );
});

test('session setup is reported apart from the queue wait and is paid only once per session', async (t) => {
  const directory = fixtureDirectory(t, 'circus-fictional-session-setup-');
  const source = fictionalSource(
    directory,
    'fictional-session-setup.pdf',
    fictionalPdf('Fictional Juniper Vale laboratory summary'),
    'fictional-intake-session-setup',
  );

  // Sequential, so neither read waits behind the other: the first pays fork() plus the
  // document open plus verifiedOpen()'s SHA-256 over the whole retained original, and
  // the second reuses that ready session.
  const cold = await readPdfEvidencePage(source, 1, 0);
  const warm = await readPdfEvidencePage(source, 1, 0);

  assert.equal(typeof cold.sessionSetupMs, 'number');
  assert.equal(typeof warm.sessionSetupMs, 'number');
  assert.ok(
    cold.sessionSetupMs > 0,
    `the first read of a fresh session pays a measurable setup cost, got ${cold.sessionSetupMs}`,
  );
  assert.ok(
    warm.sessionSetupMs < cold.sessionSetupMs,
    `a reused session reports a smaller setup cost, got ${warm.sessionSetupMs} against ` +
      `${cold.sessionSetupMs}`,
  );
  // Neither read queued behind anything, so the split is what makes the setup cost
  // visible at all — it used to be folded into queueWaitMs and read as contention.
  assert.ok(cold.queueWaitMs >= 0);
  assert.ok(
    cold.sessionSetupMs > cold.queueWaitMs,
    'on an uncontended cold read the setup dominates the queue wait',
  );
});
