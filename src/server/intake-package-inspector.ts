import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { open, type Entry, type ZipFile } from 'yauzl';
import { pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';

const MIB = 1024 * 1024;

// Read central-directory metadata first, then stream each selected member. No
// archive path is ever extracted or executed. The caller isolates this work in
// a time-limited Node subprocess, including decompression and hashing.
export async function inspectPackage(path: string, selected: number | null = null) {
  const archive = await new Promise<ZipFile>((resolve, reject) =>
    open(path, { lazyEntries: true, autoClose: false, strictFileNames: true }, (error, zip) =>
      error ? reject(error) : resolve(zip!),
    ),
  );
  // Keep errors handled between reads; the active read also observes failures.
  let failure: Error | undefined;
  archive.on('error', (error: Error) => {
    failure = error;
  });
  try {
    if (archive.entryCount > 10000) throw new Error('ZIP inventory exceeds 10,000 entries');
    const entries = await new Promise<Entry[]>((resolve, reject) => {
      const entries: Entry[] = [];
      const seen = new Set<string>();
      let namesSize = 0,
        expandedSize = 0;
      archive.once('error', reject);
      archive.on('entry', (entry: Entry) => {
        try {
          const name = entry.fileName;
          const parts = name.replace(/\/$/, '').split('/');
          const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (
            !name ||
            entry.fileNameRaw.some((byte) => byte < 32 || byte === 127) ||
            [...name].length > 2000 ||
            name.startsWith('/') ||
            /[\\:\x00-\x1f\x7f]/.test(name) ||
            parts.some((part) => ['', '.', '..'].includes(part)) ||
            seen.has(name) ||
            (mode && mode !== 0o100000 && mode !== 0o040000)
          ) {
            throw new Error('Unsafe or duplicate ZIP member');
          }
          seen.add(name);
          namesSize += Buffer.byteLength(name);
          if (namesSize > 2 * MIB) throw new Error('ZIP inventory names exceed 2 MiB');
          if (entry.uncompressedSize > 25 * MIB) throw new Error('ZIP member exceeds 25 MiB');
          if (![0, 8].includes(entry.compressionMethod))
            throw new Error(
              'Unsupported ZIP compression; export with stored or deflate compression',
            );
          if (entry.generalPurposeBitFlag & 1)
            throw new Error('Encrypted ZIP needs an unencrypted export');
          if (name.endsWith('/')) {
            if (entry.uncompressedSize)
              throw new Error('ZIP directory contains unexpected payload bytes');
          } else {
            entries.push(entry);
            expandedSize += entry.uncompressedSize;
            if (entries.length > 5000 || expandedSize > 100 * MIB)
              throw new Error('ZIP inventory exceeds 5,000 files or 100 MiB expanded bytes');
          }
          archive.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      archive.once('end', () => {
        archive.removeListener('error', reject);
        resolve(entries);
      });
      archive.readEntry();
    });
    if (
      selected !== null &&
      (!Number.isSafeInteger(selected) || selected < 0 || selected >= entries.length)
    )
      throw new Error('ZIP member outside inventory');
    const output = [];
    let expanded = 0;
    for (const [ordinal, entry] of entries.entries()) {
      if (selected !== null && selected !== ordinal) continue;
      if (failure) throw failure;
      const local = await archive.readLocalFileHeaderPromise(entry);
      if (
        !local.fileName.equals(entry.fileNameRaw) ||
        local.compressionMethod !== entry.compressionMethod ||
        local.generalPurposeBitFlag !== entry.generalPurposeBitFlag
      )
        throw new Error('ZIP local header does not match inventory');
      const stream = await new Promise<Readable>((resolve, reject) =>
        archive.openReadStream(entry, (error, stream) =>
          error ? reject(error) : resolve(stream!),
        ),
      );
      const digest = createHash('sha256');
      let size = 0,
        checksum = 0;
      const chunks: Buffer[] = [];
      for await (const value of stream) {
        const chunk = Buffer.from(value);
        size += chunk.length;
        expanded += chunk.length;
        if (size > 25 * MIB || expanded > 100 * MIB || size > entry.uncompressedSize)
          throw new Error('ZIP expanded byte limit exceeded');
        digest.update(chunk);
        checksum = crc32(chunk, checksum);
        if (selected !== null) chunks.push(chunk);
      }
      if (size !== entry.uncompressedSize)
        throw new Error('ZIP member size does not match inventory');
      if (checksum !== entry.crc32) throw new Error('ZIP member checksum does not match inventory');
      output.push({
        ordinal,
        filename: entry.fileName,
        bytes: size,
        compressedBytes: entry.compressedSize,
        sourceHash: digest.digest('hex'),
        ...(selected === null ? {} : { data: Buffer.concat(chunks).toString('base64') }),
      });
    }
    if (failure) throw failure;
    return output;
  } catch (error) {
    // The library rejects some names before emitting an entry. Preserve the
    // public refusal message and avoid reflecting an untrusted path in it.
    if (
      error instanceof Error &&
      /^(invalid relative path|absolute path|invalid characters in fileName):/.test(error.message)
    )
      throw new Error('Unsafe or duplicate ZIP member');
    throw error;
  } finally {
    archive.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(
      JSON.stringify(
        await inspectPackage(
          process.argv[2]!,
          process.argv[3] === undefined ? null : Number(process.argv[3]),
        ),
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'ZIP inspection failed');
    process.exitCode = 1;
  }
}
