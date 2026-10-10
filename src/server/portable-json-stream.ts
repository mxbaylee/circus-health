import { openSync, closeSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { portableWork } from './portable-work.ts';

/** Parse one portable row at a time. The selected file's digest is checked by
 * the caller before any rows can become a recovery input. No JSON re-encoding
 * is used to verify that digest. Memory is a read block plus one logical row. */
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
  }: {
    candidate?: boolean;
    arrayFields?: readonly string[];
    requireTables?: boolean;
    tablesStart?: () => void;
    parseTables?: boolean;
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
  function value(): unknown {
    space();
    let result = '',
      depth = 0,
      quoted = false,
      escaped = false;
    while (true) {
      const ch = peek();
      if (!ch || (!quoted && depth === 0 && /^[\x20\t\r\n,:}\]]$/.test(ch))) break;
      take();
      result += ch;
      if (quoted) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
    }
    lastValueBytes = Buffer.byteLength(result);
    return JSON.parse(result);
  }
  function object(each: (key: string) => void) {
    expect('{');
    space();
    if (peek() === '}') {
      take();
      return;
    }
    while (true) {
      const key = value();
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
      const parsed = value();
      portableWork('generationRows', 1);
      portableWork('maxRowBytes', lastValueBytes, true);
      row(name, parsed);
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
    value();
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
    closeSync(fd);
  }
}
