/** Selected portable original metadata, not independent recovery authority. */
import { createHmac, randomBytes } from 'node:crypto';
import { disposableSqlite } from './disposable-sqlite.ts';
import type { PortableProjectionCell } from './portable-projection-row.ts';

type Original = Readonly<{ path: string; sha256: string; bytes: number }>;

export interface PortableOriginalInventory {
  add(table: 'source_files' | 'assets', cells: readonly PortableProjectionCell[]): void;
  originals(): Iterable<Original>;
  count(): number;
  close(): void;
}

/** Only a successfully addressable filesystem path needs to become a JS scalar. */
export function createPortableOriginalInventory(
  checkpoint: () => void,
  onSelectedOriginal: (
    original: Readonly<{ path: string; sha256: string; bytes: number }>,
  ) => void = () => {},
): PortableOriginalInventory {
  const scratch = disposableSqlite('health-portable-originals-');
  const db = scratch.db;
  const key = randomBytes(32);
  let closed = false;
  let failed = false;
  let operating = false;
  let total = 0;
  const current = () => {
    if (closed || failed) throw Error('Portable original inventory unavailable');
    checkpoint();
    if (closed || failed) throw Error('Portable original inventory unavailable');
  };
  const enter = () => {
    if (operating) {
      failed = true;
      throw Error('Portable original inventory reentry');
    }
    if (closed || failed) throw Error('Portable original inventory unavailable');
    operating = true;
  };
  const order = (value: Original): Buffer => {
    const bytes = Buffer.from([value.path, value.sha256, value.bytes].toString(), 'utf16le');
    bytes.swap16();
    return bytes;
  };
  const sign = (value: Original) =>
    createHmac('sha256', key)
      .update(order(value))
      .update(JSON.stringify([value.path, value.sha256, value.bytes]))
      .digest('hex');
  const text = (cell: PortableProjectionCell | undefined, maxUnits: number): string => {
    if (!cell || cell.kind !== 'text') throw Error('Invalid portable original metadata');
    let value = '';
    for (const piece of cell.pieces()) {
      current();
      if (piece.length > maxUnits - value.length) throw Error('Invalid portable original metadata');
      value += piece;
    }
    return value;
  };
  try {
    db.exec(
      'CREATE TABLE originals(path TEXT PRIMARY KEY,sort BLOB,sha256 TEXT,bytes INTEGER,mac TEXT)',
    );
    return {
      add(table, cells) {
        enter();
        try {
          current();
          const byName = new Map(cells.map((cell) => [cell.name, cell]));
          // A successful profileOriginal resolves one OS pathname; 4096 UTF-16
          // units exceeds the maximum addressable pathname on supported hosts.
          const path = text(byName.get(table === 'assets' ? 'stored_path' : 'path'), 4096);
          const sha256 = text(byName.get('sha256'), 64);
          const size = byName.get('bytes');
          if (
            !path ||
            !/^[a-f0-9]{64}$/.test(sha256) ||
            !size ||
            size.kind !== 'number' ||
            !Number.isSafeInteger(size.value) ||
            size.value < 0
          )
            throw Error('Invalid portable original metadata');
          const original: Original = { path, sha256, bytes: size.value };
          onSelectedOriginal(original);
          const prior = db
            .prepare('SELECT path,sort,sha256,bytes,mac FROM originals WHERE path=?')
            .get(path);
          if (prior) {
            const previous: Original = {
              path: String(prior.path),
              sha256: String(prior.sha256),
              bytes: Number(prior.bytes),
            };
            if (
              prior.mac !== sign(previous) ||
              !(prior.sort instanceof Uint8Array) ||
              !Buffer.from(prior.sort).equals(order(previous)) ||
              previous.sha256 !== sha256 ||
              previous.bytes !== size.value
            )
              throw Error('Conflicting original metadata');
          } else {
            db.prepare('INSERT INTO originals VALUES(?,?,?,?,?)').run(
              path,
              order(original),
              sha256,
              size.value,
              sign(original),
            );
            total++;
            if (!Number.isSafeInteger(total)) throw Error('Portable original inventory overflow');
          }
          current();
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          operating = false;
        }
      },
      *originals() {
        enter();
        let complete = false;
        let visited = 0;
        try {
          current();
          for (const row of db
            .prepare('SELECT path,sort,sha256,bytes,mac FROM originals ORDER BY sort')
            .iterate()) {
            current();
            const original: Original = {
              path: String(row.path),
              sha256: String(row.sha256),
              bytes: Number(row.bytes),
            };
            if (
              !Number.isSafeInteger(original.bytes) ||
              !(row.sort instanceof Uint8Array) ||
              !Buffer.from(row.sort).equals(order(original)) ||
              row.mac !== sign(original)
            )
              throw Error('Portable original inventory changed');
            visited++;
            yield original;
            current();
            const after = db
              .prepare('SELECT path,sort,sha256,bytes,mac FROM originals WHERE path=?')
              .get(original.path);
            if (
              !after ||
              after.path !== original.path ||
              !(after.sort instanceof Uint8Array) ||
              !Buffer.from(after.sort).equals(order(original)) ||
              after.sha256 !== original.sha256 ||
              after.bytes !== original.bytes ||
              after.mac !== sign(original)
            )
              throw Error('Portable original inventory changed');
          }
          current();
          if (
            visited !== total ||
            Number(db.prepare('SELECT COUNT(*) AS n FROM originals').get()!.n) !== total
          )
            throw Error('Portable original inventory changed');
          complete = true;
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          if (!complete) failed = true;
          operating = false;
        }
      },
      count() {
        enter();
        try {
          current();
          if (Number(db.prepare('SELECT COUNT(*) AS n FROM originals').get()!.n) !== total)
            throw Error('Portable original inventory changed');
          current();
          return total;
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          operating = false;
        }
      },
      close() {
        if (operating) {
          failed = true;
          throw Error('Portable original inventory active');
        }
        if (closed) return;
        closed = true;
        scratch.close();
      },
    };
  } catch (error) {
    scratch.close();
    throw error;
  }
}
