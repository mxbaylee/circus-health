import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

export interface FictionalPdfPage {
  content: Buffer;
  font?: 'Helvetica' | 'Courier';
  image?: { bytes: Buffer; width: number; height: number };
}

/** Generated artifacts must not be written into any Git checkout, including through a symlink. */
export function assertFictionalOutputPath(path: string) {
  let directory = realpathSync(dirname(resolve(path)));
  for (;;) {
    if (existsSync(join(directory, '.git')))
      throw Error('Fictional artifacts must remain outside Git');
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}

/** Streams one independently fictional page at a time; never buffers the PDF.
 * Optional exact-size padding is unreferenced, so it measures verification/range
 * overhead without pretending comment filler is representative page content.
 */
export function writeFictionalPdf(
  path: string,
  options: { pages: number; pageAt: (page: number) => FictionalPdfPage; targetBytes?: number },
) {
  const { pages, pageAt, targetBytes = 0 } = options;
  assertFictionalOutputPath(path);
  if (
    !Number.isSafeInteger(pages) ||
    pages < 1 ||
    pages > 10_000 ||
    !Number.isSafeInteger(targetBytes) ||
    targetBytes < 0 ||
    targetBytes > 1024 ** 3
  )
    throw new Error('Fictional PDF fixture options exceed their bounds.');
  const fd = openSync(path, 'wx', 0o600);
  const identity = fstatSync(fd);
  let maxPagePayloadBytes = 0;
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
      const prepared = pageAt(page);
      if (
        !Buffer.isBuffer(prepared.content) ||
        (prepared.font !== undefined && !['Helvetica', 'Courier'].includes(prepared.font))
      )
        throw Error('Invalid fictional PDF page');
      const scan = prepared.image;
      const pageBytes = prepared.content.byteLength + (scan?.bytes.byteLength || 0);
      if (
        pageBytes > 64 * 1024 * 1024 ||
        (scan &&
          (!Buffer.isBuffer(scan.bytes) ||
            !Number.isSafeInteger(scan.width) ||
            scan.width < 1 ||
            !Number.isSafeInteger(scan.height) ||
            scan.height < 1))
      )
        throw Error('Fictional PDF page exceeds bounds');
      maxPagePayloadBytes = Math.max(maxPagePayloadBytes, pageBytes);
      object(
        id,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /${prepared.font || 'Helvetica'} >> >> ${scan ? `/XObject << /Scan ${id + 2} 0 R >>` : ''} >> /Contents ${id + 1} 0 R >>`,
      );
      stream(id + 1, deflateSync(prepared.content), '/Filter /FlateDecode');
      if (scan) {
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
      maxPagePayloadBytes,
    };
  } catch (error) {
    const current = existsSync(path) ? lstatSync(path) : null;
    if (current?.ino === identity.ino && current.dev === identity.dev) rmSync(path);
    throw error;
  } finally {
    closeSync(fd);
  }
}
