import { spawn } from 'node:child_process';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import type { SourceTextIssue, SourceTextSpan } from '../shared/intake-source-text.ts';

export const SOURCE_OCR_POLICY = Object.freeze({
  version: '1',
  language: 'eng',
  psm: 3,
  confidenceFloor: 0.6,
  maxDimension: 1800,
  maxPixels: 32_000_000,
  maxInputBytes: 64 * 1024 * 1024,
  maxOutputBytes: 8 * 1024 * 1024,
  timeoutMs: 60_000,
});
export interface LocatedNativeText {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SourceOcrResult {
  width: number;
  height: number;
  spans: SourceTextSpan[];
  issues: SourceTextIssue[];
  ocrAvailable: boolean;
}
/** Inspect dimensions before native decoding can allocate an attacker-sized raster. */
export function sourceRasterDimensions(bytes: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0,
    height = 0;
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    width = b.readUInt32BE(16);
    height = b.readUInt32BE(20);
    for (let offset = 8; offset + 12 <= b.length;) {
      const length = b.readUInt32BE(offset);
      if (offset + 12 + length > b.length) break;
      if (
        b.subarray(offset + 4, offset + 8).toString() === 'acTL' &&
        length >= 8 &&
        b.readUInt32BE(offset + 8) > 1
      )
        throw Error('IMAGE_MULTIFRAME_UNSUPPORTED');
      offset += 12 + length;
    }
  } else if (
    b.length >= 12 &&
    b.subarray(0, 4).toString() === 'RIFF' &&
    b.subarray(8, 12).toString() === 'WEBP'
  ) {
    const kind = b.subarray(12, 16).toString();
    if (kind === 'VP8X' && b.length >= 30) {
      if (b[20] & 2) throw Error('IMAGE_MULTIFRAME_UNSUPPORTED');
      width = b.readUIntLE(24, 3) + 1;
      height = b.readUIntLE(27, 3) + 1;
    } else if (
      kind === 'VP8 ' &&
      b.length >= 30 &&
      b.subarray(23, 26).equals(Buffer.from([157, 1, 42]))
    ) {
      width = b.readUInt16LE(26) & 0x3fff;
      height = b.readUInt16LE(28) & 0x3fff;
    } else if (kind === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
  } else if (b[0] === 255 && b[1] === 216) {
    let offset = 2;
    while (offset + 4 <= b.length) {
      if (b[offset++] !== 255) break;
      while (b[offset] === 255) offset++;
      const marker = b[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > b.length) break;
      const length = b.readUInt16BE(offset);
      if (length < 2 || offset + length > b.length) break;
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        ) &&
        length >= 8
      ) {
        height = b.readUInt16BE(offset + 3);
        width = b.readUInt16BE(offset + 5);
        break;
      }
      offset += length;
    }
  }
  if (!width || !height || width * height > SOURCE_OCR_POLICY.maxPixels)
    throw Error('IMAGE_PIXEL_LIMIT');
  return { width, height };
}
function area(box: number[]) {
  return box[2] * box[3];
}
function overlap(a: number[], b: number[]) {
  const intersection =
    Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return intersection / Math.max(1e-12, Math.min(area(a), area(b)));
}
/** TSV is data, never shell input. Preserve decimal/negation/punctuation exactly. */
export function parseSourceOcrTsv(
  tsv: string,
  page: number,
  width: number,
  height: number,
): SourceTextSpan[] {
  const spans: SourceTextSpan[] = [];
  const rows = tsv.split(/\r?\n/);
  if (!rows[0]?.startsWith('level\tpage_num\t')) throw Error('OCR_OUTPUT_INVALID');
  for (const row of rows.slice(1)) {
    const fields = row.split('\t');
    if (fields[0] !== '5') continue;
    const [left, top, w, h, confidence] = fields.slice(6, 11).map(Number);
    const text = fields.slice(11).join('\t');
    if (!text.trim()) continue;
    if (
      ![left, top, w, h, confidence].every(Number.isFinite) ||
      left < 0 ||
      top < 0 ||
      w <= 0 ||
      h <= 0 ||
      left + w > width + 1 ||
      top + h > height + 1 ||
      confidence < 0 ||
      confidence > 100
    )
      throw Error('OCR_OUTPUT_INVALID');
    spans.push({
      id: `p${page}-ocr-${spans.length}`,
      text,
      provenance: 'ocr',
      confidence: confidence / 100,
      region: {
        page,
        box: [
          left / width,
          top / height,
          Math.min(w, width - left) / width,
          Math.min(h, height - top) / height,
        ],
      },
    });
    if (spans.length > 50_000) throw Error('OCR_OUTPUT_LIMIT');
  }
  return spans;
}
export function composeSourceReadings(
  page: number,
  native: LocatedNativeText[],
  ocr: SourceTextSpan[],
) {
  const spans: SourceTextSpan[] = native.map((item, index) => ({
    id: `p${page}-native-${index}`,
    text: item.text,
    provenance: 'native',
    region: {
      page,
      ...(item.width > 0 && item.height > 0
        ? { box: [item.x, item.y, item.width, item.height] as [number, number, number, number] }
        : {}),
    },
  }));
  const issues: SourceTextIssue[] = [];
  const issue = (kind: SourceTextIssue['kind'], detail: string, span?: SourceTextSpan) =>
    issues.push({
      id: `p${page}-${kind}-${issues.length}`,
      region: span?.region || { page },
      kind,
      detail,
      status: 'open',
    });
  for (const word of ocr) {
    const intersecting = spans.filter(
      (span) =>
        span.provenance === 'native' &&
        span.region.box &&
        overlap(span.region.box, word.region.box!) > 0.5,
    );
    if (intersecting.length) {
      // A word may be contained in a full native line. Reader agreement cannot
      // establish completeness, and substring matches must have word boundaries.
      const literal = intersecting
        .map((span) => span.text)
        .join(' ')
        .split(/\s+/);
      if (!literal.includes(word.text)) {
        intersecting[0].alternatives ||= [];
        intersecting[0].alternatives.push({ text: word.text, adapter: 'tesseract-eng-psm3-v1' });
        issue(
          'disagreement',
          'Native text and local OCR disagree here. Compare with the original; neither reading is verified.',
          word,
        );
      }
    } else spans.push(word);
    if ((word.confidence ?? 0) < SOURCE_OCR_POLICY.confidenceFloor)
      issue(
        'confidence',
        'Local OCR is uncertain. This is a tentative reading, not verified source text.',
        word,
      );
  }
  // No inferred table edges: alignment, multi-column order, continuations and
  // cross-page headers require explicit review until a structural adapter qualifies.
  issue(
    'structure',
    'Check reading order, table cells, headers and cross-page relationships. This adapter does not establish those relationships.',
  );
  issue(
    'coverage',
    'Inspect the full original page for omitted text, annotations and non-English or handwritten content. Empty signals do not prove completeness.',
  );
  return { spans, issues };
}
async function tesseract(image: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const linux = process.platform === 'linux';
    const args = [
      'stdin',
      'stdout',
      '-l',
      SOURCE_OCR_POLICY.language,
      '--psm',
      String(SOURCE_OCR_POLICY.psm),
      'tsv',
    ];
    const child = spawn(
      linux ? '/bin/sh' : 'tesseract',
      linux
        ? ['-c', 'ulimit -v 786432 || exit 126; exec tesseract "$@"', 'source-ocr', ...args]
        : args,
      {
        env: { PATH: process.env.PATH || '/usr/bin:/bin', OMP_THREAD_LIMIT: '1', LANG: 'C' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0,
      done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) {
        child.kill('SIGKILL');
        reject(error);
      } else resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(() => finish(Error('OCR_TIMEOUT')), SOURCE_OCR_POLICY.timeoutMs);
    child.on('error', () => finish(Error('OCR_UNAVAILABLE')));
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => {}); // May contain source text; never log diagnostics.
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > SOURCE_OCR_POLICY.maxOutputBytes) finish(Error('OCR_OUTPUT_LIMIT'));
      else chunks.push(chunk);
    });
    child.on('close', (code) => finish(code === 0 ? undefined : Error('OCR_UNAVAILABLE')));
    child.stdin.end(image);
  });
}
/** Runs only inside the bounded source worker; originals never leave this host. */
export async function extractRasterSource(
  imageBytes: Uint8Array,
  page: number,
  native: LocatedNativeText[],
): Promise<SourceOcrResult> {
  if (imageBytes.byteLength > SOURCE_OCR_POLICY.maxInputBytes) throw Error('IMAGE_INPUT_LIMIT');
  sourceRasterDimensions(imageBytes);
  const image = await loadImage(Buffer.from(imageBytes));
  if (!image.width || !image.height || image.width * image.height > SOURCE_OCR_POLICY.maxPixels)
    throw Error('IMAGE_PIXEL_LIMIT');
  const scale = Math.min(1, SOURCE_OCR_POLICY.maxDimension / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale)),
    height = Math.max(1, Math.round(image.height * scale));
  const canvas = createCanvas(width, height),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);
  let ocr: SourceTextSpan[] = [],
    ocrAvailable = true,
    reason = '';
  try {
    ocr = parseSourceOcrTsv(await tesseract(canvas.toBuffer('image/png')), page, width, height);
  } catch (error) {
    ocrAvailable = false;
    reason = error instanceof Error ? error.message : 'OCR_FAILED';
  }
  const combined = composeSourceReadings(page, native, ocr);
  if (!ocrAvailable)
    combined.issues.push({
      id: `p${page}-ocr-unavailable`,
      region: { page },
      kind: 'unsupported',
      status: 'open',
      detail: `Local OCR could not finish (${reason}). Native text remains retained; inspect/transcribe the full source. English OCR is provided by the supported Compose deployment.`,
    });
  // A fixed pixel grid identifies unexplained visible ink. This is a prioritizer,
  // not a text detector: rules, photographs and signatures can also trigger it.
  const pixels = ctx.getImageData(0, 0, width, height).data,
    tile = 32;
  const covered = combined.spans.filter((s) => s.region.box).map((s) => s.region.box!);
  const mask = new Uint8Array(width * height);
  for (const [bx, by, bw, bh] of covered) {
    const left = Math.max(0, Math.floor((bx - 0.002) * width)),
      right = Math.min(width, Math.ceil((bx + bw + 0.002) * width));
    for (
      let y = Math.max(0, Math.floor((by - 0.002) * height));
      y < Math.min(height, Math.ceil((by + bh + 0.002) * height));
      y++
    )
      mask.fill(1, y * width + left, y * width + right);
  }
  let regions = 0;
  for (let y = 0; y < height; y += tile)
    for (let x = 0; x < width; x += tile) {
      let unexplained = 0;
      for (let yy = y; yy < Math.min(height, y + tile); yy += 2)
        for (let xx = x; xx < Math.min(width, x + tile); xx += 2) {
          const i = (yy * width + xx) * 4;
          if (pixels[i] + pixels[i + 1] + pixels[i + 2] >= 480) continue;
          if (!mask[yy * width + xx]) unexplained++;
        }
      if (unexplained >= 8 && regions++ < 200)
        combined.issues.push({
          id: `p${page}-ink-${x}-${y}`,
          region: {
            page,
            box: [
              x / width,
              y / height,
              Math.min(tile, width - x) / width,
              Math.min(tile, height - y) / height,
            ],
          },
          kind: 'coverage',
          status: 'open',
          detail:
            'Visible marks are not covered by retained text. Inspect this area; it may be text, a diagram or a non-text mark.',
        });
    }
  return { width, height, ...combined, ocrAvailable };
}
