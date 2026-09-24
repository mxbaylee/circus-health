import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { encodeIntakeImage, type IntakeImageEncoding } from '../server/intake-image.ts';
import { disposePdfEvidenceSessions, readPdfEvidencePage } from '../server/intake-pdf-session.ts';

// Independent fictional content only. The retained PDF and comparison files are
// written to a fresh temporary directory, never into the source repository.
const directory = mkdtempSync(resolve(tmpdir(), 'circus-fictional-image-formats-'));
const escaped = (text: string) =>
  text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
const line = (text: string, y: number, size: number) =>
  `BT /F1 ${size} Tf 36 ${y} Td (${escaped(text)}) Tj ET`;
const stream = [
  line('FICTIONAL FORMAT COMPARISON - NOT A HEALTH RECORD', 752, 14),
  line(
    'Invented Cedar Comet Clinic | Sample Person | All values fabricated for image testing',
    731,
    9,
  ),
  line(
    'ID     Invented observation                 Result       Unit       Reference         Note',
    712,
    9,
  ),
  ...Array.from({ length: 61 }, (_, index) =>
    line(
      `${String(index + 1).padStart(3, '0')}     Fictional marker ${String(index + 1).padStart(2, '0')}    ${((index % 9) + 0.17).toFixed(2)} +/- 0.01    mg/dL    0.10 - 9.90    < <= > >= 1/l I O 0`,
      697 - index * 10,
      index % 3 === 0 ? 6 : 7,
    ),
  ),
  line(
    'Fictional footnote: small print, decimal points, signs and units require visual review.',
    63,
    6,
  ),
  line('Transfer bytes are measured here. Clinical readability and model accuracy are not.', 48, 7),
].join('\n');
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Courier >> >> >> /Contents 4 0 R >>',
  `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
];
let pdf = '%PDF-1.4\n';
const offsets = [0];
for (const [index, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
  .slice(1)
  .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
  .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const pdfBytes = Buffer.from(pdf);
const path = resolve(directory, 'fictional-dense-page.pdf');
writeFileSync(path, pdfBytes);
const profileId = 'fictional-image-format-comparison';
try {
  const rendered = await readPdfEvidencePage(
    {
      profileId,
      id: 'fictional-dense-page',
      path,
      size: pdfBytes.byteLength,
      sourceHash: createHash('sha256').update(pdfBytes).digest('hex'),
      filename: 'fictional-dense-page.pdf',
    },
    1,
    0,
  );
  if (rendered.mimeType !== 'image/png')
    throw new Error('This comparison requires the default lossless PNG render');
  const canvas = createCanvas(rendered.width, rendered.height);
  const context = canvas.getContext('2d');
  context.drawImage(await loadImage(Buffer.from(rendered.image)), 0, 0);
  const raster = Buffer.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
  const formats: { filename: string; encoding: IntakeImageEncoding; lossless: boolean }[] = [
    { filename: 'page.png', encoding: { mimeType: 'image/png' }, lossless: true },
    {
      filename: 'page-lossless.webp',
      encoding: { mimeType: 'image/webp', quality: 100 },
      lossless: true,
    },
    ...[80, 90, 95].map((quality) => ({
      filename: `page-q${quality}.jpg`,
      encoding: { mimeType: 'image/jpeg' as const, quality },
      lossless: false,
    })),
  ];
  const results = [];
  for (const format of formats) {
    const started = performance.now();
    const encoded = encodeIntakeImage(canvas, format.encoding);
    const encodeMs = performance.now() - started;
    const output = resolve(directory, format.filename);
    writeFileSync(output, encoded.image);
    const decoded = await loadImage(encoded.image);
    const comparison = createCanvas(decoded.width, decoded.height);
    const comparisonContext = comparison.getContext('2d');
    comparisonContext.drawImage(decoded, 0, 0);
    const decodedRaster = Buffer.from(
      comparisonContext.getImageData(0, 0, decoded.width, decoded.height).data,
    );
    const pixelsEqual = decodedRaster.equals(raster);
    if (format.lossless && !pixelsEqual)
      throw new Error(`Lossless pixels changed: ${format.filename}`);
    results.push({
      ...format,
      path: output,
      bytes: encoded.image.byteLength,
      encodeMs,
      decodedPixelsEqual: pixelsEqual,
    });
  }
  const report = {
    format: 'circus-fictional-image-format-comparison-v1',
    fictional: true,
    source: path,
    width: rendered.width,
    height: rendered.height,
    runtime: process.version,
    canvasVersion: '1.0.9',
    note: 'Byte sizes for one fictional text-dense PDF raster. JPEG readability and model accuracy require separate review; PNG remains the lossless image fallback when native PDF is unavailable. Identical dimensions do not establish a vision-token saving.',
    results,
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  writeFileSync(resolve(directory, 'comparison.json'), json);
  process.stdout.write(json);
} finally {
  await disposePdfEvidenceSessions(profileId);
}
