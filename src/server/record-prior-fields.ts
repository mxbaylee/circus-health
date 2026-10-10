/** Cooperative, disposable comparison of retained record fields. Never authority. */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { disposableSqlite } from './disposable-sqlite.ts';
import {
  prepareIntakeJsonCanonical,
  type PreparedIntakeJsonCanonical,
  type IntakeJsonCanonicalHandle,
} from './intake-json-canonical.ts';
import { hashIntakeJsonScalarSteps } from './intake-json-scalar.ts';

export interface RecordFieldDigest {
  hash: string;
  bytes: number;
}
export interface PreparedRecordPriorFields {
  fields(): Iterable<string>;
  get(field: string): RecordFieldDigest | undefined;
  close(): void;
}

export async function prepareRecordPriorFields(
  pieces: Iterable<string>,
  ownerRunning: () => void,
): Promise<PreparedRecordPriorFields> {
  let canceled: unknown;
  let stopped = false;
  const assertRunning = () => {
    if (stopped) throw canceled;
    try {
      ownerRunning();
    } catch (error) {
      canceled = error;
      stopped = true;
      throw error;
    }
  };
  const scratch = disposableSqlite('circus-record-prior-fields-');
  const key = randomBytes(32),
    signature = (path: string, hash: string, bytes: number) =>
      createHmac('sha256', key)
        .update(JSON.stringify([path, hash, bytes]))
        .digest('hex');
  let complete = false;
  try {
    scratch.db.exec(
      'CREATE TABLE fields(path TEXT PRIMARY KEY,hash TEXT,bytes INTEGER,signature TEXT); BEGIN',
    );
    const insert = scratch.db.prepare(
      'INSERT INTO fields VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET hash=excluded.hash,bytes=excluded.bytes,signature=excluded.signature',
    );
    let steps = 0;
    const checkpoint = async () => {
      assertRunning();
      await setImmediate();
      assertRunning();
    };
    const fieldName = async (pieces: Iterable<string>) => {
      let name = '';
      const scalar = hashIntakeJsonScalarSteps(pieces, [], (unit) => {
        name += unit;
      });
      try {
        for (;;) {
          assertRunning();
          if (scalar.next().done) return name;
          await checkpoint();
        }
      } finally {
        scalar.return(undefined as never);
      }
    };
    const digest = async (tree: PreparedIntakeJsonCanonical, value: IntakeJsonCanonicalHandle) => {
      const hash = createHash('sha256');
      let bytes = 0;
      for (const piece of tree.pieces(value)) {
        assertRunning();
        hash.update(piece);
        bytes += Buffer.byteLength(piece);
        await checkpoint();
      }
      return { hash: hash.digest('hex'), bytes };
    };
    const visit = async (
      tree: PreparedIntakeJsonCanonical,
      root: IntakeJsonCanonicalHandle,
      rootPath: string,
    ) => {
      const pending: Array<{
        path: string;
        children: Iterator<{ name(): Iterable<string>; value: IntakeJsonCanonicalHandle }>;
      }> = [];
      let value: IntakeJsonCanonicalHandle | undefined = root,
        path = rootPath;
      while (value || pending.length) {
        assertRunning();
        if (value) {
          const found = await digest(tree, value);
          insert.run(path, found.hash, found.bytes, signature(path, found.hash, found.bytes));
          if (++steps === 64) {
            steps = 0;
            await checkpoint();
          }
          if (tree.kind(value) === 'object')
            pending.push({ path, children: tree.objectFields(value)[Symbol.iterator]() });
          value = undefined;
        }
        while (pending.length && !value) {
          const parent = pending[pending.length - 1]!,
            child = parent.children.next();
          if (child.done) pending.pop();
          else {
            path = parent.path + '.' + (await fieldName(child.value.name()));
            value = child.value.value;
          }
        }
      }
    };
    const tree = await prepareIntakeJsonCanonical(pieces, { mode: 'stringify', assertRunning });
    try {
      if (tree.kind(tree.root) !== 'object') throw Error('Prior record must be an object');
      for (const field of tree.objectFields(tree.root)) {
        const name = await fieldName(field.name());
        await visit(tree, field.value, name);
        if (!name.endsWith('_json') || tree.kind(field.value) !== 'string') continue;
        // Decode only a bounded scalar window before the second cooperative parser.
        const decoded = function* () {
          let buffer = '';
          const scalar = hashIntakeJsonScalarSteps(tree.pieces(field.value), [], (unit) => {
            buffer += unit;
          });
          try {
            for (;;) {
              assertRunning();
              const next = scalar.next();
              if (buffer) {
                yield buffer;
                buffer = '';
              }
              if (next.done) break;
            }
          } finally {
            scalar.return(undefined as never);
          }
        };
        let nested: PreparedIntakeJsonCanonical;
        try {
          nested = await prepareIntakeJsonCanonical(decoded(), {
            mode: 'stringify',
            assertRunning,
          });
        } catch (error) {
          assertRunning();
          // values() retains invalid embedded JSON as literal text.
          if (!(error instanceof Error) || error.message !== 'Invalid JSON canonical input')
            throw error;
          continue;
        }
        try {
          if (nested.kind(nested.root) === 'object')
            for (const child of nested.objectFields(nested.root))
              await visit(nested, child.value, name + '.' + (await fieldName(child.name())));
        } finally {
          nested.close();
        }
      }
    } finally {
      tree.close();
    }
    assertRunning();
    const get = scratch.db.prepare('SELECT hash,bytes,signature FROM fields WHERE path=?'),
      keys = scratch.db.prepare('SELECT path,hash,bytes,signature FROM fields ORDER BY rowid'),
      writes = scratch.db.prepare('SELECT total_changes() AS n'),
      main = scratch.db.prepare('PRAGMA main.schema_version'),
      temp = scratch.db.prepare('PRAGMA temp.schema_version'),
      peer = scratch.db.prepare('PRAGMA main.data_version');
    const count = scratch.db.prepare('SELECT count(*) AS n FROM fields').get()!.n,
      expected = [
        writes.get()!.n,
        main.get()!.schema_version,
        temp.get()!.schema_version,
        peer.get()!.data_version,
      ];
    let closed = false;
    const current = () => {
      if (
        closed ||
        !scratch.db.isOpen ||
        writes.get()!.n !== expected[0] ||
        main.get()!.schema_version !== expected[1] ||
        temp.get()!.schema_version !== expected[2] ||
        peer.get()!.data_version !== expected[3]
      )
        throw Error('Prepared prior field comparison changed');
    };
    const authentic = (path: string, row: Record<string, unknown>) => {
      if (
        typeof row.hash !== 'string' ||
        typeof row.bytes !== 'number' ||
        row.signature !== signature(path, row.hash, row.bytes)
      )
        throw Error('Prepared prior field comparison changed');
    };
    complete = true;
    return {
      fields: function* () {
        current();
        let seen = 0;
        for (const row of keys.iterate()) {
          current();
          const path = row.path as string;
          authentic(path, row);
          seen++;
          yield path;
        }
        current();
        if (seen !== count) throw Error('Prepared prior field membership changed');
      },
      get(field) {
        current();
        const row = get.get(field) as (RecordFieldDigest & { signature: string }) | undefined;
        if (row) authentic(field, row as unknown as Record<string, unknown>);
        current();
        return row && { hash: row.hash, bytes: row.bytes };
      },
      close() {
        if (closed) return;
        closed = true;
        key.fill(0);
        scratch.close();
      },
    };
  } finally {
    if (!complete) {
      key.fill(0);
      scratch.close();
    }
  }
}

export function recordFieldDigest(value: string): RecordFieldDigest {
  return {
    hash: createHash('sha256').update(value).digest('hex'),
    bytes: Buffer.byteLength(value),
  };
}

/** Exact JSON.stringify string bytes, without allocating its whole encoding. */
export async function recordStringFieldDigest(
  value: string,
  assertRunning: () => void,
): Promise<RecordFieldDigest> {
  const hash = createHash('sha256');
  let bytes = 2;
  assertRunning();
  hash.update('"');
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + 4096, value.length);
    const last = value.charCodeAt(end - 1),
      next = value.charCodeAt(end);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff)
      end++;
    const piece = JSON.stringify(value.slice(offset, end)).slice(1, -1);
    hash.update(piece);
    bytes += Buffer.byteLength(piece);
    offset = end;
    assertRunning();
    await setImmediate();
    assertRunning();
  }
  hash.update('"');
  assertRunning();
  return { hash: hash.digest('hex'), bytes };
}
