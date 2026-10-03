import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { openSync, closeSync, fstatSync, writeSync } from 'node:fs';
import { fromFd, type Entry, type ZipFile } from 'yauzl';
import { pathToFileURL } from 'node:url';
import type { Readable } from 'node:stream';
import {
  PackageInspectionError,
  emptyPackageInspectionWork,
  type InspectedPackageMember,
  type PackageInspectionWork,
} from './intake-package-worker.ts';

const MIB = 1024 * 1024;
const add = (left: number, right: number) => {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0)
    throw new PackageInspectionError(
      'ZIP byte count is outside the supported integer range',
      'PACKAGE_SIZE',
    );
  return result;
};
/** Inspector owns this descriptor. Production uses an inherited descriptor in
 * an isolated process. Original/member filesystem paths never cross its protocol. */
export async function inspectPackageDescriptor(
  sourceFd: number,
  selected: number | null = null,
  outputFd?: number,
  progress: (work: PackageInspectionWork) => void = () => {},
) {
  const work = emptyPackageInspectionWork();
  let current: { filename: string; ordinal: number } | undefined;
  const fail = (message: string, reasonCode: string): never => {
    throw new PackageInspectionError(message, reasonCode, current?.filename, current?.ordinal, {
      ...work,
    });
  };
  if ((selected === null) !== (outputFd === undefined))
    fail('ZIP selection requires a private output descriptor', 'PACKAGE_SELECTION');
  if (!fstatSync(sourceFd).isFile()) fail('ZIP source is not a regular file', 'PACKAGE_SOURCE');
  const archive = await new Promise<ZipFile>((resolve, reject) =>
    fromFd(
      sourceFd,
      { lazyEntries: true, autoClose: false, strictFileNames: true },
      (error, zip) => {
        if (error) {
          closeSync(sourceFd);
          reject(
            new PackageInspectionError('ZIP central directory could not be read', 'PACKAGE_FORMAT'),
          );
        } else resolve(zip!);
      },
    ),
  );
  let failure: Error | undefined;
  archive.on('error', (error: Error) => {
    failure = error;
  });
  try {
    if (archive.entryCount > 10000)
      fail(
        'ZIP inventory exceeds the current 10,000-entry processing safeguard; original retained',
        'PACKAGE_METADATA',
      );
    const entries = await new Promise<Entry[]>((resolve, reject) => {
      const entries: Entry[] = [],
        seen = new Set<string>();
      let namesSize = 0,
        expandedSize = 0;
      let ended = false;
      const rejectOnce = (error: unknown) => {
        if (!ended) {
          ended = true;
          reject(error);
        }
      };
      archive.once('error', () =>
        rejectOnce(
          new PackageInspectionError(
            'ZIP inventory contains unsafe names or unreadable metadata',
            'PACKAGE_FORMAT',
            current?.filename,
            current?.ordinal,
            { ...work },
          ),
        ),
      );
      archive.on('entry', (entry: Entry) => {
        if (ended) return;
        try {
          current = undefined;
          const name = entry.fileName,
            parts = name.replace(/\/$/, '').split('/');
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
          )
            fail('Unsafe or duplicate ZIP member', 'PACKAGE_UNSAFE');
          current = { filename: name, ordinal: entries.length };
          if (
            ![entry.uncompressedSize, entry.compressedSize].every(
              (value) => Number.isSafeInteger(value) && value >= 0,
            )
          )
            fail('ZIP member declares an invalid byte count', 'PACKAGE_SIZE');
          seen.add(name);
          namesSize = add(namesSize, Math.max(Buffer.byteLength(name), entry.fileNameRaw.length));
          if (namesSize > 2 * MIB)
            fail(
              'ZIP inventory names exceed the current 2 MiB processing safeguard; original retained',
              'PACKAGE_METADATA',
            );
          if (![0, 8].includes(entry.compressionMethod))
            fail(
              'Unsupported ZIP compression; export with stored or deflate compression',
              'PACKAGE_COMPRESSION',
            );
          if (entry.generalPurposeBitFlag & 1)
            fail('Encrypted ZIP needs an unencrypted export', 'PACKAGE_ENCRYPTED');
          if (name.endsWith('/')) {
            if (entry.uncompressedSize)
              fail('ZIP directory contains unexpected payload bytes', 'PACKAGE_DIRECTORY');
          } else {
            // Yauzl has already decoded ZIP64/Unicode fields. Preserve the
            // checked raw name for local-header comparison, but do not keep
            // arbitrary comments/extra-field backing buffers per member.
            entry.fileNameRaw = Buffer.from(entry.fileNameRaw);
            entry.extraFieldRaw = Buffer.alloc(0);
            entry.extraFields = [];
            entry.fileCommentRaw = Buffer.alloc(0);
            entry.comment = '';
            entry.fileComment = '';
            entries.push(entry);
            expandedSize = add(expandedSize, entry.uncompressedSize);
            if (entries.length > 5000)
              fail(
                'ZIP inventory exceeds the current 5,000-file processing safeguard; original retained',
                'PACKAGE_METADATA',
              );
          }
          work.entries++;
          if (work.entries % 100 === 0) progress({ ...work });
          // Yauzl can reject the next name before emitting its entry. Do not
          // misattribute that failure to the preceding valid member.
          current = undefined;
          archive.readEntry();
        } catch (error) {
          rejectOnce(error);
        }
      });
      archive.once('end', () => {
        if (!ended) {
          ended = true;
          resolve(entries);
        }
      });
      archive.readEntry();
    });
    current = undefined;
    if (
      selected !== null &&
      (!Number.isSafeInteger(selected) || selected < 0 || selected >= entries.length)
    )
      fail('ZIP member outside inventory', 'PACKAGE_SELECTION');
    const members: InspectedPackageMember[] = [];
    let lastReported = 0;
    for (const [ordinal, entry] of entries.entries()) {
      if (selected !== null && selected !== ordinal) continue;
      current = { filename: entry.fileName, ordinal };
      if (failure) fail('ZIP source could not be read', 'PACKAGE_FORMAT');
      const local = await archive.readLocalFileHeaderPromise(entry);
      if (
        !local.fileName.equals(entry.fileNameRaw) ||
        local.compressionMethod !== entry.compressionMethod ||
        local.generalPurposeBitFlag !== entry.generalPurposeBitFlag
      )
        fail('ZIP local header does not match inventory', 'PACKAGE_HEADER');
      const stream = await new Promise<Readable>((resolve, reject) =>
        archive.openReadStream(entry, (error, stream) =>
          error ? reject(error) : resolve(stream!),
        ),
      );
      const digest = createHash('sha256');
      let size = 0,
        checksum = 0;
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        size = add(size, chunk.length);
        if (size > entry.uncompressedSize)
          fail('ZIP member size does not match inventory', 'PACKAGE_SIZE');
        work.memberReadBytes = add(work.memberReadBytes, chunk.length);
        work.memberChunks++;
        work.peakChunkBytes = Math.max(work.peakChunkBytes, chunk.length);
        digest.update(chunk);
        work.hashBytes = add(work.hashBytes, chunk.length);
        checksum = crc32(chunk, checksum);
        work.crcBytes = add(work.crcBytes, chunk.length);
        if (outputFd !== undefined) {
          let offset = 0;
          while (offset < chunk.length) {
            const written = writeSync(outputFd, chunk, offset, chunk.length - offset);
            if (!written) fail('ZIP staging write made no progress', 'PACKAGE_STORAGE');
            offset += written;
            work.writtenBytes = add(work.writtenBytes, written);
          }
        }
        if (work.memberReadBytes - lastReported >= MIB) {
          progress({ ...work });
          lastReported = work.memberReadBytes;
        }
      }
      if (size !== entry.uncompressedSize)
        fail('ZIP member size does not match inventory', 'PACKAGE_SIZE');
      if (checksum !== entry.crc32)
        fail('ZIP member checksum does not match inventory', 'PACKAGE_CHECKSUM');
      members.push({
        ordinal,
        filename: entry.fileName,
        bytes: size,
        compressedBytes: entry.compressedSize,
        sourceHash: digest.digest('hex'),
      });
      work.membersVerified++;
      progress({ ...work });
    }
    if (failure) fail('ZIP source could not be read', 'PACKAGE_FORMAT');
    return { members, work };
  } catch (error) {
    if (error instanceof PackageInspectionError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (['ENOSPC', 'EDQUOT', 'EIO', 'EROFS', 'EACCES', 'EBADF'].includes(code || ''))
      fail('ZIP staging storage is unavailable; original retained', 'PACKAGE_STORAGE');
    return fail('ZIP member could not be safely decoded; original retained', 'PACKAGE_FORMAT');
  } finally {
    archive.close();
  }
}

/** Compatibility helper for local fixture callers. Selected payloads require an
 * output descriptor; no API returns a member-sized Buffer or base64 string. */
export async function inspectPackage(
  path: string,
  selected: number | null = null,
  outputFd?: number,
) {
  return (await inspectPackageDescriptor(openSync(path, 'r'), selected, outputFd)).members;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
  try {
    const result = await inspectPackageDescriptor(
      3,
      process.argv[2] === undefined ? null : Number(process.argv[2]),
      process.argv[2] === undefined ? undefined : 4,
      (work) => {
        send({ type: 'progress', work });
      },
    );
    for (const member of result.members) send({ type: 'member', member });
    send({ type: 'complete', work: result.work });
  } catch (error) {
    const failure =
      error instanceof PackageInspectionError
        ? error
        : new PackageInspectionError('ZIP inspection failed', 'PACKAGE_FORMAT');
    send({
      type: 'error',
      message: failure.message,
      reasonCode: failure.reasonCode,
      filename: failure.filename,
      ordinal: failure.ordinal,
      work: failure.work,
    });
    process.exitCode = 1;
  }
}
