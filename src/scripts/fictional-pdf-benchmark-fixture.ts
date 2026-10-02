import { writeFictionalPdf } from './fictional-pdf-writer.ts';
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

/** Preserve the benchmark's existing content and optional explicit padding. */
export function writeFictionalBenchmarkPdf(
  path: string,
  pages: number,
  kind: FictionalPdfKind,
  targetBytes = 0,
) {
  if (!['mixed', 'dense', 'scan', 'sparse'].includes(kind))
    throw Error('Invalid fictional benchmark kind');
  return writeFictionalPdf(path, {
    pages,
    targetBytes,
    pageAt(page) {
      const pageKind = fictionalPageKind(kind, page);
      return {
        content:
          pageKind === 'scan'
            ? Buffer.from('q 612 0 0 792 0 0 cm /Scan Do Q\n')
            : pageKind === 'dense'
              ? denseContent(page, pages)
              : Buffer.from(text(fictionalPageMarker(page, pages), 30, 730, 12)),
        ...(pageKind === 'scan' ? { image: scannedPage(page, pages) } : {}),
      };
    },
  });
}
