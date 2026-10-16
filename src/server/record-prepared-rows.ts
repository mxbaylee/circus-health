import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync, StatementSync, type SQLInputValue } from 'node:sqlite';
import { disposableSqlite } from './disposable-sqlite.ts';

const prepare = DatabaseSync.prototype.prepare,
  nativeGet = StatementSync.prototype.get,
  nativeRun = StatementSync.prototype.run;
const PART_UNITS = 4096,
  PART_BYTES = 16384;
const get = (statement: StatementSync, ...args: SQLInputValue[]) =>
  Reflect.apply(nativeGet, statement, args) as ReturnType<StatementSync['get']>;
const run = (statement: StatementSync, ...args: SQLInputValue[]) =>
  Reflect.apply(nativeRun, statement, args) as ReturnType<StatementSync['run']>;
function changed(): never {
  throw Error('Prepared record rows changed or expired');
}
function* utf8Parts(value: string): Generator<Uint8Array> {
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + PART_UNITS, value.length);
    if (
      end < value.length &&
      value.charCodeAt(end - 1) >= 0xd800 &&
      value.charCodeAt(end - 1) <= 0xdbff &&
      value.charCodeAt(end) >= 0xdc00 &&
      value.charCodeAt(end) <= 0xdfff
    )
      end++;
    const source = value.slice(offset, end),
      bytes = Buffer.from(source);
    if (bytes.length > PART_BYTES || bytes.toString('utf8') !== source) changed();
    yield bytes;
    offset = end;
  }
}

/** Changed-row transport only. Every row stream must be exhausted before its
 * parsed value is trusted; original acceptance and publication remain with its owner. */
export function createRecordPreparedRows() {
  const scratch = disposableSqlite('circus-record-prepared-rows-'),
    key = randomBytes(32);
  let closed = false,
    sealed = false,
    count = 0,
    totalParts = 0,
    changes = 0n,
    readParts = 0,
    readBytes = 0,
    maxPartBytes = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    key.fill(0);
    scratch.close();
  };
  try {
    scratch.db.exec(
      'CREATE TABLE rows(position INTEGER PRIMARY KEY,units INTEGER NOT NULL,bytes INTEGER NOT NULL,parts INTEGER NOT NULL,signature TEXT NOT NULL);' +
        'CREATE TABLE row_parts(position INTEGER NOT NULL,part INTEGER NOT NULL,value BLOB NOT NULL,PRIMARY KEY(position,part)) WITHOUT ROWID;',
    );
    const statement = (sql: string) => Reflect.apply(prepare, scratch.db, [sql]) as StatementSync,
      insert = statement('INSERT INTO rows VALUES(?,?,?,?,?)'),
      insertPart = statement('INSERT INTO row_parts VALUES(?,?,?)'),
      selected = statement('SELECT * FROM rows WHERE position=?'),
      selectedPart = statement('SELECT part,value FROM row_parts WHERE position=? AND part=?'),
      membership = statement('SELECT count(*) AS n FROM rows'),
      partMembership = statement('SELECT count(*) AS n FROM row_parts'),
      stamp = statement('SELECT total_changes() AS n'),
      schema = statement('PRAGMA schema_version'),
      temp = statement('PRAGMA temp.schema_version'),
      peer = statement('PRAGMA data_version');
    stamp.setReadBigInts(true);
    const schemaVersion = get(schema)!.schema_version,
      tempVersion = get(temp)!.schema_version,
      peerVersion = get(peer)!.data_version;
    const current = () => {
      if (
        closed ||
        !scratch.db.isOpen ||
        get(stamp)!.n !== changes ||
        get(schema)!.schema_version !== schemaVersion ||
        get(temp)!.schema_version !== tempVersion ||
        get(peer)!.data_version !== peerVersion
      )
        changed();
    };
    const membershipCurrent = () => {
      current();
      if (get(membership)!.n !== count || get(partMembership)!.n !== totalParts) changed();
      current();
    };
    const rowPieces = function* (
      position: number,
      finished: { value: boolean },
    ): Generator<string> {
      let complete = false;
      try {
        current();
        const row = get(selected, position);
        if (
          !row ||
          row.position !== position ||
          !Number.isSafeInteger(row.units) ||
          !Number.isSafeInteger(row.bytes) ||
          !Number.isSafeInteger(row.parts) ||
          (row.units as number) < 0 ||
          (row.bytes as number) < 0 ||
          (row.parts as number) < 0 ||
          (row.parts as number) > totalParts ||
          typeof row.signature !== 'string'
        )
          changed();
        const signature = createHmac('sha256', key).update(String(position)).update(':');
        let units = 0,
          bytes = 0;
        for (let part = 0; part < (row.parts as number); part++) {
          current();
          const item = get(selectedPart, position, part);
          if (!item || item.part !== part || !(item.value instanceof Uint8Array)) changed();
          const value = item.value as Uint8Array;
          if (!value.length || value.length > PART_BYTES) changed();
          const text = Buffer.from(value).toString('utf8');
          if (!Buffer.from(text).equals(value)) changed();
          signature.update(value);
          units += text.length;
          bytes += value.length;
          readParts++;
          readBytes += value.length;
          maxPartBytes = Math.max(maxPartBytes, value.length);
          yield text;
          current();
        }
        if (units !== row.units || bytes !== row.bytes || signature.digest('hex') !== row.signature)
          changed();
        current();
        complete = true;
        finished.value = true;
      } finally {
        if (!complete) close();
      }
    };
    const pieceRows = function* (): Generator<Iterable<string>> {
      let complete = false;
      try {
        membershipCurrent();
        if (!sealed) changed();
        for (let position = 0; position < count; position++) {
          const finished = { value: false },
            pieces = rowPieces(position, finished);
          yield pieces;
          if (!finished.value) changed();
        }
        membershipCurrent();
        complete = true;
      } finally {
        if (!complete) close();
      }
    };
    return Object.freeze({
      append(value: string) {
        try {
          current();
          if (sealed || typeof value !== 'string') changed();
          const signature = createHmac('sha256', key).update(String(count)).update(':');
          let parts = 0,
            bytes = 0;
          for (const part of utf8Parts(value)) {
            if (run(insertPart, count, parts++, part).changes !== 1) changed();
            changes++;
            totalParts++;
            bytes += part.length;
            signature.update(part);
          }
          if (run(insert, count, value.length, bytes, parts, signature.digest('hex')).changes !== 1)
            changed();
          changes++;
          count++;
          current();
        } catch (error) {
          close();
          throw error;
        }
      },
      seal() {
        try {
          membershipCurrent();
          sealed = true;
        } catch (error) {
          close();
          throw error;
        }
      },
      pieceRows,
      *values(): Generator<string> {
        for (const pieces of pieceRows()) yield [...pieces].join('');
      },
      work() {
        return { readParts, readBytes, maxPartBytes };
      },
      close,
    });
  } catch (error) {
    close();
    throw error;
  }
}
