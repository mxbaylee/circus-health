/** Piece-backed canonical source range. The caller retains full-original authority. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

const CHUNK = 16 * 1024;
type Identity = Readonly<{
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: bigint;
  nlink: bigint;
}>;
const identity = (stat: BigIntStats): Identity => ({
  dev: stat.dev,
  ino: stat.ino,
  size: stat.size,
  mtimeNs: stat.mtimeNs,
  ctimeNs: stat.ctimeNs,
  mode: stat.mode,
  nlink: stat.nlink,
});
const same = (a: Identity, b: Identity) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.mode === b.mode &&
  a.nlink === b.nlink;

export interface PortableRawRange {
  pieces(): Iterable<string>;
  assertComplete(): void;
  close(): void;
}

/** `path` must already come from the selected original's scoped path resolver. */
export function openPortableRawRange(
  path: string,
  originalBytes: number,
  offset: number,
  bytes: number,
  expectedSha256: string,
  checkpoint: () => void,
): PortableRawRange {
  if (
    !Number.isSafeInteger(originalBytes) ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(bytes) ||
    offset < 0 ||
    bytes < 1 ||
    offset + bytes > originalBytes
  )
    throw Error('Invalid canonical raw JSON reference');
  checkpoint();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let closed = false;
  let failed = false;
  let completed = 0;
  try {
    const initial = identity(fstatSync(fd, { bigint: true }));
    const named = lstatSync(path, { bigint: true });
    if (
      !named.isFile() ||
      !same(initial, identity(named)) ||
      initial.size !== BigInt(originalBytes)
    )
      throw Error('Canonical raw JSON source changed');
    const current = () => {
      if (closed || failed) throw Error('Canonical raw JSON range unavailable');
      checkpoint();
      const held = fstatSync(fd, { bigint: true });
      const entry = lstatSync(path, { bigint: true });
      if (
        !held.isFile() ||
        !entry.isFile() ||
        !same(initial, identity(held)) ||
        !same(initial, identity(entry))
      )
        throw Error('Canonical raw JSON source changed');
    };
    return {
      *pieces() {
        current();
        const block = Buffer.alloc(CHUNK);
        const comparison = Buffer.alloc(CHUNK);
        const decoder = new StringDecoder('utf8');
        const raw = createHash('sha256');
        let at = 0;
        let decodedAt = 0;
        let done = false;
        const verifyDecoded = (text: string) => {
          const encoded = Buffer.from(text);
          if (decodedAt + encoded.length > bytes) throw Error('Canonical JSON is not valid UTF-8');
          for (let cursor = 0; cursor < encoded.length;) {
            const count = Math.min(CHUNK, encoded.length - cursor);
            let copied = 0;
            while (copied < count) {
              current();
              const read = readSync(
                fd,
                comparison,
                copied,
                count - copied,
                offset + decodedAt + cursor + copied,
              );
              current();
              if (!read) throw Error('Canonical JSON is not valid UTF-8');
              copied += read;
            }
            if (!comparison.subarray(0, count).equals(encoded.subarray(cursor, cursor + count)))
              throw Error('Canonical JSON is not valid UTF-8');
            cursor += count;
          }
          decodedAt += encoded.length;
        };
        try {
          while (at < bytes) {
            current();
            const size = readSync(fd, block, 0, Math.min(CHUNK, bytes - at), offset + at);
            if (!size) throw Error('Canonical raw JSON reference checksum failed');
            current();
            const part = block.subarray(0, size);
            raw.update(part);
            at += size;
            const text = decoder.write(part);
            if (text) {
              verifyDecoded(text);
              yield text;
            }
          }
          const tail = decoder.end();
          if (tail) {
            verifyDecoded(tail);
            yield tail;
          }
          current();
          const actual = raw.digest('hex');
          if (actual !== expectedSha256)
            throw Error('Canonical raw JSON reference checksum failed');
          if (decodedAt !== bytes) throw Error('Canonical JSON is not valid UTF-8');
          completed++;
          done = true;
        } finally {
          if (!done) failed = true;
        }
      },
      assertComplete() {
        current();
        if (!completed) throw Error('Canonical raw JSON range was not consumed');
      },
      close() {
        if (closed) return;
        closed = true;
        closeSync(fd);
        if (failed) throw Error('Canonical raw JSON range incomplete');
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}
