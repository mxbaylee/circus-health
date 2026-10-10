/** Private lexical span index; preserves duplicate keys and every input byte.
 * Frames and value spans live on disposable disk, never in accepted authority. */
import { mkdtempSync, openSync, readSync, writeSync, closeSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { disposableSqlite } from './disposable-sqlite.ts';
import { iterateIntakeJsonVerification } from './intake-json-verify.ts';

export interface IntakeJsonLexicalSpan {
  id: number;
  parent: number | null;
  ordinal: number;
  start: number;
  end: number;
  prefix: number;
  nameStart: number | null;
  nameEnd: number | null;
  shape: 'object' | 'array' | 'scalar';
}
export interface IntakeJsonLexicalWork {
  inputUnits: number;
  scratchReadBytes: number;
  scratchWrittenBytes: number;
  nodes: number;
  sqliteCalls: number;
  peakBufferBytes: number;
}
export async function prepareIntakeJsonLexical(
  pieces: Iterable<string>,
  options: {
    assertRunning?: () => void;
    onWork?: (work: Readonly<IntakeJsonLexicalWork>) => void;
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'intake-json-lexical-'));
  let fd: number | undefined,
    scratch: ReturnType<typeof disposableSqlite> | undefined,
    closed = false;
  const work: IntakeJsonLexicalWork = {
    inputUnits: 0,
    scratchReadBytes: 0,
    scratchWrittenBytes: 0,
    nodes: 0,
    sqliteCalls: 0,
    peakBufferBytes: 0,
  };
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      if (fd !== undefined) closeSync(fd);
    } finally {
      try {
        scratch?.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
        options.onWork?.(Object.freeze({ ...work }));
      }
    }
  };
  try {
    fd = openSync(join(directory, 'lexical'), 'wx+', 0o600);
    scratch = disposableSqlite('intake-json-lexical-index-');
    const db = scratch.db;
    db.exec(
      'CREATE TABLE spans(id INTEGER PRIMARY KEY,parent INTEGER,ordinal INTEGER,start INTEGER,end INTEGER,prefix INTEGER,nameStart INTEGER,nameEnd INTEGER,shape TEXT,tail INTEGER,next INTEGER); CREATE INDEX children ON spans(parent,ordinal)',
    );
    const write = (bytes: Buffer) => {
      let done = 0;
      while (done < bytes.length) {
        const n = writeSync(fd!, bytes, done, bytes.length - done);
        if (!n) throw Error('Lexical spool write stalled');
        done += n;
      }
      work.scratchWrittenBytes += done;
    };
    const input = function* () {
      for (const piece of pieces) {
        options.assertRunning?.();
        for (let at = 0; at < piece.length; at += 2048) {
          const part = piece.slice(at, at + 2048),
            bytes = Buffer.from(part, 'utf16le');
          write(bytes);
          work.inputUnits += part.length;
          work.peakBufferBytes = Math.max(work.peakBufferBytes, bytes.length);
          yield part;
        }
      }
    };
    for (const _progress of iterateIntakeJsonVerification(input())) {
      options.assertRunning?.();
      await setImmediate();
    }
    const read = (start: number, units: number) => {
      const bytes = Buffer.allocUnsafe(units * 2);
      let done = 0;
      while (done < bytes.length) {
        const n = readSync(fd!, bytes, done, bytes.length - done, start * 2 + done);
        if (!n) throw Error('Truncated lexical spool');
        done += n;
      }
      work.scratchReadBytes += done;
      work.peakBufferBytes = Math.max(work.peakBufferBytes, bytes.length * 2);
      return bytes.toString('utf16le');
    };
    let at = 0,
      block = '',
      blockStart = -1;
    const peek = () => {
      if (at === work.inputUnits) return '';
      if (at < blockStart || at >= blockStart + block.length) {
        blockStart = at;
        block = read(at, Math.min(2048, work.inputUnits - at));
      }
      return block[at - blockStart]!;
    };
    const ws = async () => {
      while (/^[\x20\t\r\n]$/.test(peek())) {
        at++;
        if (at % 4096 === 0) {
          options.assertRunning?.();
          await setImmediate();
        }
      }
    };
    const stringEnd = async () => {
      if (peek() !== '"') throw Error('Invalid lexical string');
      at++;
      let checked = at;
      while (at < work.inputUnits) {
        if (at - checked >= 4096) {
          checked = at;
          options.assertRunning?.();
          await setImmediate();
        }
        const ch = peek();
        at++;
        if (ch === '\\') at++;
        else if (ch === '"') return;
      }
      throw Error('Incomplete lexical string');
    };
    const insert = db.prepare(
        'INSERT INTO spans(parent,ordinal,start,end,prefix,nameStart,nameEnd,shape,tail,next) VALUES(?,?,?,NULL,?,?,?,?,?,0)',
      ),
      get = db.prepare('SELECT * FROM spans WHERE id=?'),
      finish = db.prepare('UPDATE spans SET end=? WHERE id=?'),
      progress = db.prepare('UPDATE spans SET tail=?,next=next+1 WHERE id=?');
    const load = (id: number) => {
      work.sqliteCalls++;
      const row = get.get(id);
      if (!row) throw Error('Missing lexical frame');
      return row;
    };
    const begin = async (
      parent: number | null,
      ordinal: number,
      prefix: number,
      nameStart: number | null,
      nameEnd: number | null,
    ) => {
      const start = at,
        ch = peek(),
        shape = ch === '{' ? 'object' : ch === '[' ? 'array' : 'scalar';
      work.sqliteCalls++;
      work.nodes++;
      const id = Number(
        insert.run(parent, ordinal, start, prefix, nameStart, nameEnd, shape, start)
          .lastInsertRowid,
      );
      if (shape !== 'scalar') {
        at++;
        return id;
      }
      if (ch === '"') await stringEnd();
      else
        while (peek() && !/^[,}\]\x20\t\r\n]$/.test(peek())) {
          at++;
          if (at % 4096 === 0) {
            options.assertRunning?.();
            await setImmediate();
          }
        }
      work.sqliteCalls++;
      finish.run(at, id);
      return id;
    };
    await ws();
    const root = await begin(null, 0, 0, null, null);
    let current: number | null = root,
      steps = 0;
    while (current !== null) {
      options.assertRunning?.();
      if (++steps % 128 === 0) await setImmediate();
      const row = load(current);
      if (row.end !== null) {
        if (row.parent === null) {
          current = null;
          continue;
        }
        work.sqliteCalls++;
        progress.run(row.end, row.parent);
        current = Number(row.parent);
        continue;
      }
      await ws();
      const end = row.shape === 'object' ? '}' : ']';
      if (peek() === end) {
        at++;
        work.sqliteCalls++;
        finish.run(at, current);
        continue;
      }
      if (Number(row.next) > 0) {
        if (peek() !== ',') throw Error('Invalid lexical separator');
        at++;
        await ws();
      }
      let nameStart: number | null = null,
        nameEnd: number | null = null;
      if (row.shape === 'object') {
        nameStart = at;
        await stringEnd();
        nameEnd = at;
        await ws();
        if (peek() !== ':') throw Error('Invalid lexical property');
        at++;
        await ws();
      }
      current = await begin(current, Number(row.next), Number(row.tail), nameStart, nameEnd);
    }
    const span = (id: number): IntakeJsonLexicalSpan => {
      if (closed) throw Error('Closed lexical index');
      const row = load(id);
      return {
        id,
        parent: row.parent === null ? null : Number(row.parent),
        ordinal: Number(row.ordinal),
        start: Number(row.start),
        end: Number(row.end),
        prefix: Number(row.prefix),
        nameStart: row.nameStart === null ? null : Number(row.nameStart),
        nameEnd: row.nameEnd === null ? null : Number(row.nameEnd),
        shape: row.shape as IntakeJsonLexicalSpan['shape'],
      };
    };
    return {
      root: span(root),
      work,
      *children(parent: IntakeJsonLexicalSpan): Generator<IntakeJsonLexicalSpan> {
        let ordinal = -1;
        const next = db.prepare(
          'SELECT id,ordinal FROM spans WHERE parent=? AND ordinal>? ORDER BY ordinal LIMIT 1',
        );
        while (true) {
          if (closed) throw Error('Closed lexical index');
          work.sqliteCalls++;
          const row = next.get(parent.id, ordinal);
          if (!row) return;
          ordinal = Number(row.ordinal);
          yield span(Number(row.id));
        }
      },
      *pieces(start: number, end: number): Generator<string> {
        if (
          closed ||
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          end < start ||
          end > work.inputUnits
        )
          throw Error('Invalid lexical span');
        while (start < end) {
          options.assertRunning?.();
          const part = read(start, Math.min(2048, end - start));
          start += part.length;
          yield part;
        }
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
