import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  realpathSync,
  openSync,
  closeSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { crc32, createDeflateRaw } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
// Empty permission-sandbox .git sentinels are not checkouts. Actual Git metadata
// (directory HEAD or worktree .git file) still excludes generated artifacts.
function assertOutsideCheckout(path: string) {
  let dir = realpathSync(dirname(resolve(path)));
  const repository = realpathSync(fileURLToPath(new URL('../../../', import.meta.url)));
  const location = relative(repository, dir);
  if (!location || (!location.startsWith('..') && !location.startsWith('/')))
    throw Error('Fictional output must remain outside this repository');
  for (;;) {
    if (
      (existsSync(join(dir, '.git')) && lstatSync(join(dir, '.git')).isFile()) ||
      existsSync(join(dir, '.git', 'HEAD')) ||
      existsSync(join(dir, '.git', 'config'))
    )
      throw Error('Fictional output must remain outside Git');
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** Minimal two-page independent fictional PDF, padded in fixed blocks before
 * its xref. Padding is an unreferenced stream, not representative page content. */
export function writeLargeFictionalPdf(path: string, targetBytes: number) {
  assertOutsideCheckout(path);
  const fd = openSync(path, 'wx', 0o600);
  const hash = createHash('sha256'),
    offsets = [0];
  let bytes = 0;
  const write = (value: string | Buffer) => {
    const chunk = typeof value === 'string' ? Buffer.from(value) : value;
    let offset = 0;
    while (offset < chunk.length) offset += writeSync(fd, chunk, offset);
    hash.update(chunk);
    bytes += chunk.length;
  };
  const object = (id: number, value: string | (() => void)) => {
    offsets[id] = bytes;
    write(`${id} 0 obj\n`);
    if (typeof value === 'string') write(value);
    else value();
    write('\nendobj\n');
  };
  try {
    write('%PDF-1.4\n');
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    object(2, '<< /Type /Pages /Count 2 /Kids [3 0 R 5 0 R] >>');
    for (let page = 1; page <= 2; page++) {
      const id = 3 + (page - 1) * 2;
      object(
        id,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${id + 1} 0 R >>`,
      );
      const text = `BT /F1 12 Tf 30 720 Td (Fictional ${page === 1 ? 'FIRST' : 'SECOND'} page marker) Tj ET`;
      object(id + 1, `<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    }
    // This measures large source processing, so an exact round size is unnecessary.
    const padding = targetBytes - bytes;
    object(7, () => {
      write(`<< /Length ${padding} >>\nstream\n`);
      const block = Buffer.alloc(64 * 1024, 'x');
      for (let left = padding; left > 0; left -= block.length)
        write(block.subarray(0, Math.min(left, block.length)));
      write('\nendstream');
    });
    const xref = bytes;
    write(
      `xref\n0 8\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
        .join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
    );
    return { bytes, sourceHash: hash.digest('hex') };
  } finally {
    closeSync(fd);
  }
}

/** Fixed-block fictional fixture writer. Payloads and compressed members stay on disk. */
export async function writeLargeStreamedZip(
  path: string,
  entries: { name: string; path: string; store?: boolean; corruptCRC?: boolean }[],
) {
  assertOutsideCheckout(path);
  const zip = await open(path, 'wx', 0o600);
  const central: Buffer[] = [];
  const members = [];
  let position = 0;
  const write = async (bytes: Buffer) => {
    let offset = 0;
    while (offset < bytes.length) {
      const result = await zip.write(bytes, offset, bytes.length - offset, position);
      offset += result.bytesWritten;
      position += result.bytesWritten;
    }
  };
  try {
    for (const [ordinal, entry] of entries.entries()) {
      const compressedPath = `${path}.${ordinal}.compressed`;
      let bytes = 0,
        checksum = 0,
        peakChunkBytes = 0;
      const digest = createHash('sha256');
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          peakChunkBytes = Math.max(peakChunkBytes, chunk.length);
          digest.update(chunk);
          checksum = crc32(chunk, checksum);
          callback(null, chunk);
        },
      });
      const input = createReadStream(entry.path, { highWaterMark: 64 * 1024 });
      if (entry.store)
        await pipeline(
          input,
          meter,
          createWriteStream(compressedPath, { flags: 'wx', mode: 0o600 }),
        );
      else
        await pipeline(
          input,
          meter,
          createDeflateRaw(),
          createWriteStream(compressedPath, { flags: 'wx', mode: 0o600 }),
        );
      const compressed = await open(compressedPath, 'r');
      const compressedBytes = (await compressed.stat()).size;
      await compressed.close();
      const name = Buffer.from(entry.name);
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(entry.store ? 0 : 8, 8);
      header.writeUInt32LE(entry.corruptCRC ? checksum ^ 1 : checksum, 14);
      header.writeUInt32LE(compressedBytes, 18);
      header.writeUInt32LE(bytes, 22);
      header.writeUInt16LE(name.length, 26);
      const directory = Buffer.alloc(46);
      directory.writeUInt32LE(0x02014b50);
      directory.writeUInt16LE(0x314, 4);
      header.copy(directory, 6, 4, 30);
      directory.writeUInt32LE((0o100600 * 65536) >>> 0, 38);
      directory.writeUInt32LE(position, 42);
      central.push(directory, name);
      await write(header);
      await write(name);
      for await (const chunk of createReadStream(compressedPath, { highWaterMark: 64 * 1024 }))
        await write(chunk);
      members.push({
        ordinal,
        filename: entry.name,
        bytes,
        compressedBytes,
        sourceHash: digest.digest('hex'),
        peakChunkBytes,
      });
    }
    const directoryOffset = position;
    for (const chunk of central) await write(chunk);
    const directoryBytes = position - directoryOffset;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directoryBytes, 12);
    end.writeUInt32LE(directoryOffset, 16);
    await write(end);
    await zip.sync();
    return { members, bytes: position };
  } finally {
    await zip.close();
  }
}
