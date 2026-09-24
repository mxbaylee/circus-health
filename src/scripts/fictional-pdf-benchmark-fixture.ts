import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { createCanvas } from '@napi-rs/canvas';

export type FictionalPdfKind = 'mixed' | 'dense' | 'scan' | 'sparse';
export const fictionalPageKind = (kind: FictionalPdfKind, page: number) =>
  kind === 'mixed' ? (page % 2 ? 'dense' : 'scan') : kind;
export const fictionalPageMarker = (page: number, pages: number) =>
  `FICTIONAL BENCHMARK - page ${page} of ${pages}`;

const escapeText = (value: string) => value.replace(/[\\()]/g, '\\$&');
const text = (value: string, x: number, y: number, size: number) =>
  `BT /F1 ${size} Tf ${x} ${y} Td (${escapeText(value)}) Tj ET\n`;
const row = (index: number, page: number) =>
  `Synthetic panel ${String(index + 1).padStart(2, '0')}    ${(((index + page) % 13) + 0.17).toFixed(2)} +/- 0.01    unit-X    0.10 - 19.90    < <= > >= 1/l I O 0`;

function denseContent(page: number, pages: number) {
  let content = text(fictionalPageMarker(page, pages), 30, 762, 13);
  content += text(
    'Independent fabricated test material. Not a health record or diagnostic image.',
    30,
    744,
    8,
  );
  for (let index = 0; index < 64; index++) {
    const y = 724 - index * 8.4;
    if (index % 2 === 0) content += `q 0.94 0.96 0.98 rg 28 ${y - 2} 550 8.4 re f Q\n`;
    content += text(row(index, page), 32, y, index % 3 ? 7 : 6);
  }
  content += 'q 0.3 0.5 0.7 RG 0.6 w 30 48 260 110 re S\n';
  for (let index = 0; index < 40; index++)
    content += `${35 + index * 6} ${66 + ((index * 17 + page * 3) % 80)} ${index ? 'l' : 'm'}\n`;
  content += 'S Q\n';
  content += text('Synthetic vector series; values have no clinical meaning.', 304, 136, 7);
  content += text('Small text, decimal signs, table rules and colored vectors.', 304, 120, 7);
  content += text('No provider inference or OCR is measured by this fixture.', 304, 104, 7);
  return Buffer.from(content);
}

function scannedPage(page: number, pages: number) {
  const width = 1224,
    height = 1584;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  // Deterministic low-amplitude paper texture. Only one raster is held at a time.
  const paper = context.createImageData(width, height);
  let seed = page;
  for (let offset = 0; offset < paper.data.length; offset += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const shade = 242 + (seed >>> 28);
    paper.data[offset] = paper.data[offset + 1] = paper.data[offset + 2] = shade;
    paper.data[offset + 3] = 255;
  }
  context.putImageData(paper, 0, 0);
  context.save();
  context.translate(10, 7);
  context.rotate(0.002);
  context.fillStyle = '#202020';
  context.font = '24px sans-serif';
  context.fillText(fictionalPageMarker(page, pages), 54, 65);
  context.font = '15px sans-serif';
  context.fillText('SYNTHETIC SCAN-LIKE PAGE - no original records or patient data', 54, 95);
  for (let index = 0; index < 64; index++) {
    const y = 132 + index * 19;
    context.font = `${index % 3 ? 14 : 12}px monospace`;
    context.fillText(row(index, page), 54, y);
    context.strokeStyle = '#989898';
    context.lineWidth = 0.5;
    context.beginPath();
    context.moveTo(54, y + 4);
    context.lineTo(1130, y + 4);
    context.stroke();
  }
  context.strokeStyle = '#333333';
  context.strokeRect(54, 1370, 500, 125);
  context.beginPath();
  for (let index = 0; index < 40; index++) {
    const x = 60 + index * 12,
      y = 1380 + ((index * 13 + page * 7) % 100);
    if (index) context.lineTo(x, y);
    else context.moveTo(x, y);
  }
  context.stroke();
  context.font = '14px sans-serif';
  context.fillText('Raster pixels only. No hidden OCR text layer.', 590, 1420);
  context.restore();
  const bytes = canvas.toBuffer('image/jpeg', 85);
  canvas.width = canvas.height = 1;
  return { bytes, width, height };
}

/** Streams one independently fictional page at a time; never buffers the PDF.
 * Optional exact-size padding is unreferenced, so it measures verification/range
 * overhead without pretending comment filler is representative page content.
 */
export function writeFictionalBenchmarkPdf(
  path: string,
  pages: number,
  kind: FictionalPdfKind,
  targetBytes = 0,
) {
  if (
    !Number.isSafeInteger(pages) ||
    pages < 1 ||
    pages > 10_000 ||
    !['mixed', 'dense', 'scan', 'sparse'].includes(kind) ||
    !Number.isSafeInteger(targetBytes) ||
    targetBytes < 0 ||
    targetBytes > 1024 ** 3
  )
    throw new Error('Fictional PDF fixture options exceed their bounds.');
  const fd = openSync(path, 'wx');
  const digest = createHash('sha256');
  const offsets = [0];
  let bytes = 0,
    imageBytes = 0;
  const output = (value: string | Buffer) => {
    const buffer = typeof value === 'string' ? Buffer.from(value) : value;
    if (bytes + buffer.byteLength > 1024 ** 3)
      throw new Error('Generated fictional PDF exceeds 1 GiB.');
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset);
    digest.update(buffer);
    bytes += buffer.byteLength;
  };
  const object = (id: number, content: string | (() => void)) => {
    offsets[id] = bytes;
    output(`${id} 0 obj\n`);
    if (typeof content === 'string') output(content);
    else content();
    output('\nendobj\n');
  };
  const stream = (id: number, content: Buffer, extra = '') =>
    object(id, () => {
      output(`<< /Length ${content.length} ${extra} >>\nstream\n`);
      output(content);
      output('\nendstream');
    });
  try {
    output('%PDF-1.4\n');
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(
      2,
      `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, index) => `${3 + index * 3} 0 R`).join(' ')}] >>`,
    );
    for (let page = 1; page <= pages; page++) {
      const id = 3 + (page - 1) * 3;
      const pageKind = fictionalPageKind(kind, page);
      object(
        id,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> ${pageKind === 'scan' ? `/XObject << /Scan ${id + 2} 0 R >>` : ''} >> /Contents ${id + 1} 0 R >>`,
      );
      const content =
        pageKind === 'scan'
          ? Buffer.from('q 612 0 0 792 0 0 cm /Scan Do Q\n')
          : pageKind === 'dense'
            ? denseContent(page, pages)
            : Buffer.from(text(fictionalPageMarker(page, pages), 30, 730, 12));
      stream(id + 1, deflateSync(content), '/Filter /FlateDecode');
      if (pageKind === 'scan') {
        const scan = scannedPage(page, pages);
        imageBytes += scan.bytes.length;
        stream(
          id + 2,
          scan.bytes,
          `/Type /XObject /Subtype /Image /Width ${scan.width} /Height ${scan.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
        );
      } else object(id + 2, 'null');
    }
    const contentBytes = bytes;
    const paddingId = offsets.length;
    const tailLength = (padding: number) => {
      const header = `${paddingId} 0 obj\n<< /Length ${padding} >>\nstream\n`;
      const objectBytes = Buffer.byteLength(header + '\nendstream\nendobj\n') + padding;
      const end = bytes + objectBytes;
      const xref = `xref\n0 ${paddingId + 1}\n0000000000 65535 f \n${'0000000000 00000 n \n'.repeat(paddingId)}trailer\n<< /Size ${paddingId + 1} /Root 1 0 R >>\nstartxref\n${end}\n%%EOF\n`;
      return bytes + objectBytes + Buffer.byteLength(xref);
    };
    let paddingBytes = 0;
    if (targetBytes) {
      if (tailLength(0) > targetBytes)
        throw new Error(
          'Requested byte size is smaller than the generated page content; omit BYTES or choose a larger value.',
        );
      for (let attempt = 0; attempt < 8; attempt++)
        paddingBytes += targetBytes - tailLength(paddingBytes);
      if (paddingBytes < 0 || tailLength(paddingBytes) !== targetBytes)
        throw new Error('Could not plan exact-size padding.');
    }
    object(paddingId, () => {
      output(`<< /Length ${paddingBytes} >>\nstream\n`);
      const chunk = Buffer.alloc(256 * 1024, 'x');
      for (let left = paddingBytes; left > 0; left -= chunk.length)
        output(chunk.subarray(0, Math.min(left, chunk.length)));
      output('\nendstream');
    });
    const xref = bytes;
    output(
      `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    );
    fsyncSync(fd);
    if (targetBytes && bytes !== targetBytes)
      throw new Error('Fictional PDF size differs from its plan.');
    return {
      sourceHash: digest.digest('hex'),
      bytes,
      contentBytes,
      paddingBytes,
      embeddedJpegBytes: imageBytes,
    };
  } finally {
    closeSync(fd);
  }
}
