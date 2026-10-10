/** Fixed-window JSONL record framing for authenticated journal segment bytes. */
import { createHash } from 'node:crypto';
import { mkdtempSync, openSync, closeSync, readSync, writeSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseRecordJsonPiecesSteps } from './record-json-pieces.ts';

const SMALL_RECORD = 64 * 1024,
  WINDOW = 8192;
export interface RecordJsonLineWork {
  records: number;
  spooledRecords: number;
  spooledBytes: number;
  maxRecordBufferBytes: number;
  maxSpoolReadBytes: number;
}

/** Segment authentication remains the caller's responsibility. A scratch spool
 * cannot replace those bytes: its full digest closes before yielding a record. */
export function* readRecordJsonLines(
  segments: Iterable<Uint8Array>,
  options: {
    parseSmall?: (text: string) => unknown;
    checkpoint?: () => void;
    onWork?: (work: Readonly<RecordJsonLineWork>) => void;
  } = {},
): Generator<unknown> {
  const work: RecordJsonLineWork = {
    records: 0,
    spooledRecords: 0,
    spooledBytes: 0,
    maxRecordBufferBytes: 0,
    maxSpoolReadBytes: 0,
  };
  let small: Buffer[] = [],
    length = 0,
    directory: string | undefined,
    fd: number | undefined,
    inputHash = createHash('sha256');
  const append = (bytes: Uint8Array) => {
    if (!bytes.length) return;
    if (fd === undefined && length + bytes.length <= SMALL_RECORD) {
      small.push(Buffer.from(bytes));
      length += bytes.length;
      work.maxRecordBufferBytes = Math.max(work.maxRecordBufferBytes, length);
      return;
    }
    if (fd === undefined) {
      directory = mkdtempSync(join(tmpdir(), 'circus-record-line-'));
      fd = openSync(join(directory, 'line'), 'wx+', 0o600);
      for (const bytes of small) write(bytes);
      small = [];
    }
    write(bytes);
    length += bytes.length;
    if (!Number.isSafeInteger(length)) throw Error('Record JSONL byte count overflow');
  };
  const write = (bytes: Uint8Array) => {
    for (let offset = 0; offset < bytes.length;) {
      const take = Math.min(WINDOW, bytes.length - offset),
        written = writeSync(fd!, bytes, offset, take);
      if (!written) throw Error('Record JSONL scratch write did not advance');
      inputHash.update(bytes.subarray(offset, offset + written));
      offset += written;
      work.spooledBytes += written;
      options.checkpoint?.();
    }
  };
  const decode = (): unknown => {
    if (fd === undefined) {
      const bytes = Buffer.concat(small, length),
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return (options.parseSmall ?? JSON.parse)(text);
    }
    const expected = inputHash.digest('hex'),
      readHash = createHash('sha256'),
      decoder = new TextDecoder('utf-8', { fatal: true });
    const pieces = function* () {
      const buffer = Buffer.alloc(WINDOW);
      for (let offset = 0; offset < length;) {
        const count = readSync(fd!, buffer, 0, Math.min(WINDOW, length - offset), offset);
        if (!count) throw Error('Record JSONL scratch truncated');
        readHash.update(buffer.subarray(0, count));
        work.maxSpoolReadBytes = Math.max(work.maxSpoolReadBytes, count);
        offset += count;
        const text = decoder.decode(buffer.subarray(0, count), { stream: true });
        if (text) yield text;
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    };
    const steps = parseRecordJsonPiecesSteps(pieces());
    try {
      for (;;) {
        const next = steps.next();
        if (next.done) {
          if (readHash.digest('hex') !== expected) throw Error('Record JSONL scratch changed');
          work.spooledRecords++;
          return next.value;
        }
        options.checkpoint?.();
      }
    } finally {
      steps.return(undefined as never);
    }
  };
  try {
    for (const segment of segments) {
      const bytes = Buffer.isBuffer(segment) ? segment : Buffer.from(segment);
      let offset = 0;
      for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, offset)) {
        append(bytes.subarray(offset, end));
        const value = decode();
        work.records++;
        yield value;
        small = [];
        length = 0;
        offset = end + 1;
        if (fd !== undefined) {
          closeSync(fd);
          fd = undefined;
          rmSync(directory!, { recursive: true, force: true });
          directory = undefined;
        }
        inputHash = createHash('sha256');
      }
      append(bytes.subarray(offset));
    }
    if (length) throw Error('Partial final JSONL record');
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (directory) rmSync(directory, { recursive: true, force: true });
    options.onWork?.(Object.freeze({ ...work }));
  }
}
