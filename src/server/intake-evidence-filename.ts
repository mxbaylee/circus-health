import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { hashIntakeJsonScalar } from './intake-json-scalar.ts';

export interface EvidenceFilename {
  hash: string;
  bytes: number;
  prefix: Buffer;
  suffix: Buffer;
  utf8Hash: string;
  key(leading: readonly string[]): string;
}

// SQLite JSON extraction preserves lone UTF-16 units as their three-byte encoding.
function sqliteFilenameBytes(text: string): Buffer {
  const pieces: Buffer[] = [];
  for (const character of text) {
    const code = character.charCodeAt(0);
    pieces.push(
      character.length === 1 && code >= 0xd800 && code <= 0xdfff
        ? Buffer.from([0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)])
        : Buffer.from(character),
    );
  }
  return Buffer.concat(pieces);
}

/** Disposable path segments keep exact names out of display labels and giant JS strings. */
export function evidenceRelativeFilename(pieces: Iterable<string>, check: () => void) {
  const scratch = new DatabaseSync(':memory:');
  scratch.exec(`CREATE TABLE chunks(segment INTEGER,part INTEGER,text TEXT,PRIMARY KEY(segment,part));
    CREATE TABLE segments(segment INTEGER PRIMARY KEY,kind TEXT);
    CREATE TABLE directory(depth INTEGER PRIMARY KEY,segment INTEGER);
    CREATE TABLE target(depth INTEGER PRIMARY KEY,segment INTEGER)`);
  let nextSegment = 0;
  const insert = scratch.prepare('INSERT INTO chunks VALUES(?,?,?)');
  const split = (feed: (emit: (unit: string) => void) => void) => {
    let segment = nextSegment++,
      part = 0,
      buffer = '',
      short = '',
      units = 0;
    const flush = () => {
      check();
      if (buffer) insert.run(segment, part++, JSON.stringify(buffer));
      buffer = '';
    };
    const finish = () => {
      flush();
      scratch
        .prepare('INSERT INTO segments VALUES(?,?)')
        .run(
          segment,
          units === 0 ? 'empty' : units <= 2 && (short === '.' || short === '..') ? short : 'name',
        );
    };
    feed((unit) => {
      if (unit === '/') {
        finish();
        segment = nextSegment++;
        part = 0;
        buffer = '';
        short = '';
        units = 0;
      } else {
        units++;
        if (units <= 2) short += unit;
        buffer += unit;
        if (buffer.length >= 512) {
          if (!/[\uD800-\uDBFF]$/.test(buffer)) flush();
          else if (buffer.length > 512) {
            const high = buffer.slice(-1);
            buffer = buffer.slice(0, -1);
            flush();
            buffer = high;
          }
        }
      }
    });
    finish();
  };
  let absolute = false,
    first = true,
    sourceHash = '';
  try {
    split((emit) => {
      const scalar = hashIntakeJsonScalar(pieces, [], (unit) => {
        if (first) {
          absolute = unit === '/';
          first = false;
        }
        emit(unit);
      });
      if (scalar.kind !== 'string') throw Error('Evidence filename is not a string');
      sourceHash = scalar.hash;
    });
    const last = scratch.prepare("SELECT max(segment) n FROM segments WHERE kind<>'empty'").get()!
      .n as number | null;
    const normalize = (table: 'directory' | 'target', segment: number, kind: string) => {
      if (kind === 'empty' || kind === '.') return;
      const top = scratch
        .prepare(`SELECT depth,segment FROM ${table} ORDER BY depth DESC LIMIT 1`)
        .get();
      if (kind === '..' && top) {
        const topKind = scratch
          .prepare('SELECT kind FROM segments WHERE segment=?')
          .get(top.segment!)!.kind;
        if (topKind !== '..') {
          scratch.prepare(`DELETE FROM ${table} WHERE depth=?`).run(top.depth!);
          return;
        }
      }
      if (kind === '..' && absolute && !top) return;
      scratch
        .prepare(`INSERT INTO ${table} VALUES(?,?)`)
        .run(top ? Number(top.depth) + 1 : 0, segment);
    };
    for (const row of scratch
      .prepare('SELECT segment,kind FROM segments WHERE segment<? ORDER BY segment')
      .iterate(last ?? 0))
      normalize('directory', row.segment as number, row.kind as string);
    const directoryEnd = nextSegment;
    const directorySlash =
      last !== null &&
      last > 0 &&
      scratch.prepare('SELECT kind FROM segments WHERE segment=?').get(last - 1)?.kind === 'empty';
    let generation = 0;
    const resolve = (path: string): EvidenceFilename => {
      check();
      const selectedGeneration = ++generation;
      scratch.exec('DELETE FROM target; INSERT INTO target SELECT * FROM directory');
      scratch.prepare('DELETE FROM chunks WHERE segment>=?').run(directoryEnd);
      scratch.prepare('DELETE FROM segments WHERE segment>=?').run(directoryEnd);
      nextSegment = directoryEnd;
      split((emit) => {
        for (let at = 0; at < path.length; at++) emit(path[at]!);
      });
      for (const row of scratch
        .prepare('SELECT segment,kind FROM segments WHERE segment>=? ORDER BY segment')
        .iterate(directoryEnd))
        normalize('target', row.segment as number, row.kind as string);
      let bytes = 0,
        utf8 = createHash('sha256'),
        prefix = Buffer.alloc(0),
        suffix = Buffer.alloc(0);
      const lexical = function* (facts = false) {
        yield '"';
        let count = 0;
        const text = function* () {
          if (absolute) yield '/';
          for (const item of scratch
            .prepare('SELECT segment FROM target ORDER BY depth')
            .iterate()) {
            if (count++) yield '/';
            for (const chunk of scratch
              .prepare('SELECT text FROM chunks WHERE segment=? ORDER BY part')
              .iterate(item.segment!))
              yield JSON.parse(chunk.text as string) as string;
          }
          if (!count && !absolute) yield '.';
          if ((path.endsWith('/') || (path === '' && directorySlash)) && (count || !absolute))
            yield '/';
        };
        for (const chunk of text()) {
          check();
          const data = sqliteFilenameBytes(chunk);
          if (facts) {
            utf8.update(Buffer.from(chunk));
            bytes += data.length;
            if (prefix.length < 512) prefix = Buffer.concat([prefix, data]).subarray(0, 512);
            suffix = Buffer.concat([suffix, data]).subarray(-512);
          }
          yield JSON.stringify(chunk).slice(1, -1);
        }
        yield '"';
      };
      const hash = hashIntakeJsonScalar(lexical(true)).hash;
      check();
      return Object.freeze({
        hash,
        bytes,
        prefix,
        suffix,
        utf8Hash: utf8.digest('hex'),
        key: (leading: readonly string[]) => {
          check();
          if (selectedGeneration !== generation) throw Error('Evidence filename target changed');
          return hashIntakeJsonScalar(lexical(), leading).hash;
        },
      });
    };
    return { sourceHash, resolve, close: () => scratch.close() };
  } catch (error) {
    scratch.close();
    throw error;
  }
}
