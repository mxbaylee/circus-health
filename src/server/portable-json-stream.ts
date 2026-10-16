import {
  openSync,
  closeSync,
  readSync,
  writeSync,
  ftruncateSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  type BigIntStats,
} from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { portableWork } from './portable-work.ts';
import {
  createIntakeJsonCanonicalScratch,
  prepareIntakeJsonCanonicalSteps,
  type IntakeJsonCanonicalScratch,
  type PreparedIntakeJsonCanonical,
} from './intake-json-canonical.ts';
import { portableJsonStringPieces } from './portable-json-pieces.ts';

/** Parse one portable row at a time. The selected file's raw digest is checked
 * before the caller may commit provisional recovery rows. The default callback
 * holds one logical row; rowPieces instead uses bounded private scratch. */
export function streamPortableJson(
  path: string,
  table: (name: string, field?: boolean) => void,
  row: (table: string, value: unknown) => void,
  expected?: { bytes: number; sha256: string },
  {
    candidate = false,
    arrayFields = ['restoreOperations', 'assistantOperations', 'packetPreferences'],
    requireTables = !candidate,
    tablesStart,
    parseTables = true,
    rowPieces,
  }: {
    candidate?: boolean;
    arrayFields?: readonly string[];
    requireTables?: boolean;
    tablesStart?: () => void;
    parseTables?: boolean;
    /** Pieces are valid only during this synchronous callback. */
    rowPieces?: (
      table: string,
      pieces: Iterable<string>,
      parsed: PreparedIntakeJsonCanonical,
    ) => void;
  } = {},
): Record<string, unknown> {
  const fd = openSync(path, 'r'),
    decoder = new StringDecoder('utf8');
  const block = Buffer.alloc(64 * 1024);
  let text = '',
    offset = 0,
    ended = false;
  const digest = createHash('sha256');
  let bytes = 0,
    lastValueBytes = 0;
  let spoolDirectory: string | undefined,
    spoolPath: string | undefined,
    spoolFd: number | undefined;
  // One private canonical scratch serves every spooled key and row in turn.
  let canonicalScratch: IntakeJsonCanonicalScratch | undefined;
  portableWork('maxReadBufferBytes', block.length, true);
  function peek(): string {
    if (offset === text.length && !ended) {
      const size = readSync(fd, block, 0, block.length, null);
      bytes += size;
      portableWork('generationBytes', size);
      digest.update(block.subarray(0, size));
      text = size ? decoder.write(block.subarray(0, size)) : decoder.end();
      offset = 0;
      ended = !size;
      if (!text.length && !ended) return peek();
    }
    return text[offset] ?? '';
  }
  const take = () => {
    const ch = peek();
    if (ch) offset++;
    return ch;
  };
  const space = () => {
    while (/^[\x20\t\r\n]$/.test(peek())) take();
  };
  function expect(ch: string) {
    space();
    if (take() !== ch) throw Error('Invalid portable generation JSON');
  }
  function scanValue(append: (ch: string) => void) {
    space();
    let depth = 0,
      quoted = false,
      escaped = false;
    while (true) {
      const ch = peek();
      if (!ch || (!quoted && depth === 0 && /^[\x20\t\r\n,:}\]]$/.test(ch))) break;
      take();
      append(ch);
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
  }
  function value(): unknown {
    let result = '';
    scanValue((ch) => {
      result += ch;
    });
    lastValueBytes = Buffer.byteLength(result);
    return JSON.parse(result);
  }
  function spooledValue(
    name: string,
    deliver = true,
    inspect?: (parsed: PreparedIntakeJsonCanonical) => void,
  ) {
    if (spoolFd === undefined) {
      spoolDirectory = mkdtempSync(join(tmpdir(), 'circus-portable-row-'));
      spoolPath = join(spoolDirectory, 'row');
      spoolFd = openSync(spoolPath, 'w+');
    }
    const file = spoolFd;
    ftruncateSync(file, 0);
    let length = 0,
      buffer = '';
    const source = createHash('sha256');
    const flush = () => {
      if (!buffer) return;
      const pendingHighSurrogate = /[\uD800-\uDBFF]$/.test(buffer);
      const ready = pendingHighSurrogate ? buffer.slice(0, -1) : buffer;
      buffer = pendingHighSurrogate ? buffer.slice(-1) : '';
      if (!ready) return;
      const encoded = Buffer.from(ready, 'utf8');
      source.update(encoded);
      let written = 0;
      while (written < encoded.length) {
        const count = writeSync(file, encoded, written, encoded.length - written, length + written);
        if (!count) throw Error('Portable row scratch write failed');
        written += count;
      }
      length += encoded.length;
    };
    scanValue((ch) => {
      buffer += ch;
      if (buffer.length >= 8192) flush();
    });
    if (buffer) {
      const encoded = Buffer.from(buffer, 'utf8');
      source.update(encoded);
      let written = 0;
      while (written < encoded.length) {
        const count = writeSync(file, encoded, written, encoded.length - written, length + written);
        if (!count) throw Error('Portable row scratch write failed');
        written += count;
      }
      length += encoded.length;
    }
    lastValueBytes = length;
    const digest = source.digest('hex');
    const path = spoolPath!;
    const held = fstatSync(file, { bigint: true });
    const same = (a: BigIntStats, b: BigIntStats) =>
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.size === b.size &&
      a.mode === b.mode &&
      a.nlink === b.nlink &&
      a.mtimeNs === b.mtimeNs &&
      a.ctimeNs === b.ctimeNs;
    const current = () => {
      const named = lstatSync(path, { bigint: true });
      if (
        !held.isFile() ||
        held.nlink !== 1n ||
        held.size !== BigInt(length) ||
        !named.isFile() ||
        !same(held, named) ||
        !same(held, fstatSync(file, { bigint: true }))
      )
        throw Error('Portable row scratch changed');
    };
    current();
    let active = true;
    const pieces = function* () {
      const block = Buffer.alloc(8192),
        decoder = new StringDecoder('utf8');
      const readback = createHash('sha256');
      let offset = 0;
      while (offset < length) {
        if (!active) throw Error('Expired portable row pieces');
        current();
        const size = readSync(file, block, 0, Math.min(block.length, length - offset), offset);
        if (!size) throw Error('Portable row scratch read failed');
        current();
        readback.update(block.subarray(0, size));
        offset += size;
        const text = decoder.write(block.subarray(0, size));
        if (text) yield text;
      }
      if (!active) throw Error('Expired portable row pieces');
      current();
      if (readback.digest('hex') !== digest) throw Error('Portable row scratch changed');
      const final = decoder.end();
      if (final) yield final;
    };
    if (!canonicalScratch) {
      canonicalScratch = createIntakeJsonCanonicalScratch();
      portableWork('canonicalScratchSets', 1);
    }
    portableWork('canonicalPreparations', 1);
    const steps = prepareIntakeJsonCanonicalSteps(pieces(), {
      mode: 'stringify',
      scratch: canonicalScratch,
    });
    let parsed: PreparedIntakeJsonCanonical | undefined;
    try {
      for (;;) {
        const step = steps.next();
        if (step.done) {
          parsed = step.value;
          break;
        }
      }
      inspect?.(parsed);
      if (deliver) rowPieces?.(name, pieces(), parsed);
    } finally {
      try {
        for (const _ of pieces()) void _;
      } finally {
        try {
          parsed?.close();
          steps.return(undefined as never);
        } finally {
          active = false;
        }
      }
    }
  }
  function object(each: (key: string) => void) {
    expect('{');
    space();
    if (peek() === '}') {
      take();
      return;
    }
    while (true) {
      let key: unknown;
      if (rowPieces)
        spooledValue('', false, (parsed) => {
          if (parsed.kind(parsed.root) !== 'string') throw Error('Invalid portable generation key');
          let decoded = '';
          for (const part of portableJsonStringPieces(parsed, parsed.root)) {
            if (decoded.length + part.length > 128) {
              decoded = '';
              break;
            }
            decoded += part;
          }
          key = decoded;
        });
      else key = value();
      if (typeof key !== 'string') throw Error('Invalid portable generation key');
      expect(':');
      each(key);
      space();
      if (peek() === '}') {
        take();
        return;
      }
      expect(',');
    }
  }
  function array(name: string, field = false) {
    table(name, field);
    expect('[');
    space();
    if (peek() === ']') {
      take();
      return;
    }
    while (true) {
      let parsed: unknown;
      if (rowPieces) spooledValue(name);
      else parsed = value();
      portableWork('generationRows', 1);
      portableWork('maxRowBytes', lastValueBytes, true);
      if (!rowPieces) row(name, parsed);
      space();
      if (peek() === ']') {
        take();
        return;
      }
      expect(',');
    }
  }
  function skip() {
    space();
    if (peek() === '{') {
      if (rowPieces) {
        expect('{');
        space();
        if (peek() === '}') {
          take();
          return;
        }
        while (true) {
          spooledValue('', false, (parsed) => {
            if (parsed.kind(parsed.root) !== 'string')
              throw Error('Invalid portable generation key');
          });
          expect(':');
          skip();
          space();
          if (peek() === '}') {
            take();
            return;
          }
          expect(',');
        }
      }
      object(() => skip());
      return;
    }
    if (peek() === '[') {
      expect('[');
      space();
      if (peek() === ']') {
        take();
        return;
      }
      while (true) {
        skip();
        space();
        if (peek() === ']') {
          take();
          return;
        }
        expect(',');
      }
    }
    if (rowPieces) spooledValue('', false);
    else value();
  }
  try {
    const header: Record<string, unknown> = {};
    let tables = false;
    object((key) => {
      if (key === 'tables' && parseTables) {
        tables = true;
        tablesStart?.();
        object((name) => {
          space();
          if (candidate && peek() !== '[') {
            table(name);
            skip();
          } else array(name);
        });
      } else if (arrayFields.includes(key)) {
        array('$' + key, true);
        header[key] = true;
      } else if (candidate && !['format', 'kind', 'profileId'].includes(key)) skip();
      else if (
        [
          'format',
          'kind',
          'profileId',
          'schemaVersion',
          'revision',
          'createdAt',
          'semantics',
          'clinicalReviewRevision',
          'history',
          'rawJson',
          'databasePath',
          'databaseSha256',
          'portableSha256',
        ].includes(key)
      )
        header[key] = value();
      else skip();
    });
    space();
    if (peek() || (!tables && requireTables)) throw Error('Invalid portable generation JSON');
    if (expected && (bytes !== expected.bytes || digest.digest('hex') !== expected.sha256))
      throw Error('Portable generation checksum failed');
    return header;
  } finally {
    try {
      closeSync(fd);
      if (spoolFd !== undefined) closeSync(spoolFd);
    } finally {
      try {
        canonicalScratch?.close();
      } finally {
        if (spoolDirectory) rmSync(spoolDirectory, { recursive: true, force: true });
      }
    }
  }
}
