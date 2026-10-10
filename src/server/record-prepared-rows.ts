import { createHmac, randomBytes } from 'node:crypto';
import { disposableSqlite } from './disposable-sqlite.ts';

/** Changed-row transport only. Its record owner must authenticate predecessors,
 * operation/result and original physical evidence before accepting any replay. */
export function createRecordPreparedRows() {
  const scratch = disposableSqlite('circus-record-prepared-rows-'),
    key = randomBytes(32);
  let closed = false,
    sealed = false,
    count = 0,
    changes = 0n;
  try {
    scratch.db.exec(
      'CREATE TABLE rows(position INTEGER PRIMARY KEY,value TEXT NOT NULL,signature TEXT NOT NULL)',
    );
    const insert = scratch.db.prepare('INSERT INTO rows VALUES(?,?,?)'),
      rows = scratch.db.prepare('SELECT position,value,signature FROM rows ORDER BY position'),
      stamp = scratch.db.prepare('SELECT total_changes() AS n'),
      schema = scratch.db.prepare('PRAGMA schema_version'),
      temp = scratch.db.prepare('PRAGMA temp.schema_version'),
      peer = scratch.db.prepare('PRAGMA data_version');
    stamp.setReadBigInts(true);
    const schemaVersion = schema.get()!.schema_version,
      tempVersion = temp.get()!.schema_version,
      peerVersion = peer.get()!.data_version,
      signature = (position: number, value: string) =>
        createHmac('sha256', key).update(String(position)).update(':').update(value).digest('hex');
    const current = () => {
      if (
        closed ||
        !scratch.db.isOpen ||
        stamp.get()!.n !== changes ||
        schema.get()!.schema_version !== schemaVersion ||
        temp.get()!.schema_version !== tempVersion ||
        peer.get()!.data_version !== peerVersion
      )
        throw Error('Prepared record rows changed or expired');
    };
    return Object.freeze({
      append(value: string) {
        current();
        if (sealed || typeof value !== 'string') throw Error('Prepared record rows are sealed');
        if (insert.run(count, value, signature(count, value)).changes !== 1)
          throw Error('Prepared record row was not retained');
        changes++;
        count++;
        current();
      },
      seal() {
        current();
        sealed = true;
      },
      *values(): Generator<string> {
        current();
        if (!sealed) throw Error('Prepared record rows are not sealed');
        let seen = 0;
        for (const row of rows.iterate()) {
          current();
          if (
            row.position !== seen ||
            typeof row.value !== 'string' ||
            row.signature !== signature(seen, row.value) ||
            ++seen > count
          )
            throw Error('Prepared record rows lost original membership');
          yield row.value;
          current();
        }
        current();
        if (seen !== count) throw Error('Prepared record rows lost original membership');
      },
      close() {
        if (closed) return;
        closed = true;
        key.fill(0);
        scratch.close();
      },
    });
  } catch (error) {
    key.fill(0);
    scratch.close();
    throw error;
  }
}
