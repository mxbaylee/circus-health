import { createHmac, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { DatabaseSync, StatementSync, type SQLInputValue } from 'node:sqlite';
import { disposableSqlite } from './disposable-sqlite.ts';
import { captureRecordHeadPhysical } from './record-head-physical.ts';

const prepare = DatabaseSync.prototype.prepare,
  nativeExec = DatabaseSync.prototype.exec,
  nativeGet = StatementSync.prototype.get,
  nativeRun = StatementSync.prototype.run,
  nativeAll = StatementSync.prototype.all,
  location = DatabaseSync.prototype.location;
const bound = new WeakMap<object, DatabaseSync>();
export function recordPreparedIndexBoundTo(db: DatabaseSync, index: object): boolean {
  return bound.get(index) === db;
}
type Scalar = { kind: string; value: string | Uint8Array | null };
type Header = { position: number; sql: string; mode: string; expected: number; arguments: number };
type HashQuantum = { bytes: number; pieces: number };
const HASH_BYTES = 16384,
  HASH_PIECES = 64;
const fail = (): never => {
  throw Error('Prepared record index changed, escaped or expired');
};
const get = (statement: StatementSync, ...args: SQLInputValue[]) =>
  Reflect.apply(nativeGet, statement, args) as ReturnType<StatementSync['get']>;
const run = (statement: StatementSync, ...args: SQLInputValue[]) =>
  Reflect.apply(nativeRun, statement, args) as ReturnType<StatementSync['run']>;
function scalar(input: SQLInputValue): Scalar {
  if (input === null) return { kind: 'null', value: null };
  if (typeof input === 'string') return { kind: 'string', value: input };
  if (typeof input === 'number')
    return { kind: 'number', value: Object.is(input, -0) ? '-0' : String(input) };
  if (typeof input === 'bigint') return { kind: 'bigint', value: String(input) };
  if (ArrayBuffer.isView(input))
    return { kind: 'blob', value: Buffer.from(input.buffer, input.byteOffset, input.byteLength) };
  return fail();
}
function value(input: Scalar): SQLInputValue {
  if (input.kind === 'null' && input.value === null) return null;
  if (input.kind === 'blob' && input.value instanceof Uint8Array) return input.value;
  if (typeof input.value !== 'string') return fail();
  if (input.kind === 'string') return input.value;
  if (input.kind === 'number') return Number(input.value);
  if (input.kind === 'bigint') return BigInt(input.value);
  return fail();
}

/** Typed changed-scope transport, not acceptance authority. Seal authenticates
 * every row before final physical verification; an original scratch-file pin
 * then permits native scalar binding without terminal JSON decoding or rehash. */
export function createRecordPreparedIndex(
  db: DatabaseSync,
  { assertRunning }: { assertRunning?: () => void } = {},
) {
  const scratch = disposableSqlite('circus-record-prepared-index-'),
    key = randomBytes(32);
  let closed = false,
    busy = false,
    sealed = false,
    used = false,
    count = 0,
    changes = 0n,
    building = false,
    physical: ReturnType<typeof captureRecordHeadPhysical> | undefined;
  try {
    scratch.db.exec(
      'CREATE TABLE entries(position INTEGER PRIMARY KEY,sql TEXT NOT NULL,mode TEXT NOT NULL,expected INTEGER NOT NULL,arguments INTEGER NOT NULL,signature TEXT NOT NULL);' +
        'CREATE TABLE arguments(position INTEGER NOT NULL,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,value,PRIMARY KEY(position,ordinal));',
    );
    Reflect.apply(nativeExec, scratch.db, ['BEGIN']);
    building = true;
    const statement = (sql: string) => Reflect.apply(prepare, scratch.db, [sql]) as StatementSync,
      stamp = statement('SELECT total_changes() AS n'),
      schema = statement('PRAGMA main.schema_version'),
      peer = statement('PRAGMA main.data_version'),
      insert = statement('INSERT INTO entries VALUES(?,?,?,?,?,?)'),
      insertArg = statement('INSERT INTO arguments VALUES(?,?,?,?)'),
      selected = statement('SELECT * FROM entries WHERE position=?'),
      selectedArgs = statement(
        'SELECT ordinal,kind,value FROM arguments WHERE position=? ORDER BY ordinal',
      ),
      membership = statement('SELECT count(*) AS n FROM entries'),
      argumentMembership = statement('SELECT count(*) AS n FROM arguments');
    stamp.setReadBigInts(true);
    const originalSchema = get(schema)!.schema_version,
      originalPeer = get(peer)!.data_version;
    let argumentCount = 0;
    const current = () => {
      if (
        closed ||
        !db.isOpen ||
        !scratch.db.isOpen ||
        scratch.db.isTransaction !== building ||
        get(stamp)!.n !== changes ||
        get(schema)!.schema_version !== originalSchema ||
        get(peer)!.data_version !== originalPeer ||
        (physical && !physical.current())
      )
        fail();
    };
    const guard = () => {
      assertRunning?.();
      current();
    };
    const cooperate = async <T>(steps: Generator<void, T>): Promise<T> => {
      guard();
      let step = steps.next();
      while (!step.done) {
        guard();
        await setImmediate();
        guard();
        step = steps.next();
      }
      guard();
      return step.value;
    };
    const sign = function* (
      header: Header,
      args: readonly Scalar[],
      quantum: HashQuantum,
    ): Generator<void, string> {
      const hmac = createHmac('sha256', key);
      const piece = function* (input: string | Uint8Array): Generator<void, void> {
        const width = typeof input === 'string' ? 2 : 1,
          units = HASH_BYTES / width;
        for (let offset = 0; offset < input.length; offset += units) {
          const end = Math.min(offset + units, input.length),
            bytes = (end - offset) * width;
          if (quantum.bytes + bytes > HASH_BYTES) {
            yield;
            quantum.bytes = quantum.pieces = 0;
          }
          if (typeof input === 'string') hmac.update(input.slice(offset, end), 'utf16le');
          else hmac.update(input.subarray(offset, end));
          quantum.bytes += bytes;
          quantum.pieces++;
          if (quantum.bytes === HASH_BYTES || quantum.pieces === HASH_PIECES) {
            yield;
            quantum.bytes = quantum.pieces = 0;
          }
        }
      };
      // Only bounded typed framing is encoded; scalar contents remain streamed.
      yield* piece(
        Buffer.from(
          JSON.stringify([
            header.position,
            header.mode,
            header.expected,
            header.arguments,
            header.sql.length,
          ]),
        ),
      );
      yield* piece(header.sql);
      for (const arg of args) {
        yield* piece(Buffer.from(JSON.stringify([arg.kind, arg.value?.length ?? null])));
        if (arg.value !== null) yield* piece(arg.value);
      }
      return hmac.digest('hex');
    };
    const read = (position: number) => {
      current();
      const row = get(selected, position) as unknown as Header & { signature: string };
      if (!row || row.position !== position || !['run', 'check'].includes(row.mode)) fail();
      const args = Reflect.apply(nativeAll, selectedArgs, [position]) as Array<
        Scalar & { ordinal: number }
      >;
      if (args.length !== row.arguments || args.some((arg, ordinal) => arg.ordinal !== ordinal))
        fail();
      current();
      return { row, args };
    };
    const append = async (
      mode: 'run' | 'check',
      sql: string,
      input: readonly SQLInputValue[],
      expected: number,
    ) => {
      current();
      if (
        busy ||
        sealed ||
        used ||
        typeof sql !== 'string' ||
        !Number.isSafeInteger(expected) ||
        expected < 0
      )
        fail();
      busy = true;
      try {
        // Retain caller values synchronously before the first cooperative yield.
        const args = input.map((item) => {
            const arg = scalar(item);
            return arg.kind === 'blob'
              ? { ...arg, value: Buffer.from(arg.value as Uint8Array) }
              : arg;
          }),
          header: Header = { position: count, sql, mode, expected, arguments: args.length },
          signature = await cooperate(sign(header, args, { bytes: 0, pieces: 0 }));
        guard();
        for (let ordinal = 0; ordinal < args.length; ordinal++) {
          const arg = args[ordinal]!;
          if (run(insertArg, count, ordinal, arg.kind, arg.value).changes !== 1) fail();
          changes++;
          argumentCount++;
        }
        if (run(insert, count, sql, mode, expected, args.length, signature).changes !== 1) fail();
        changes++;
        count++;
        guard();
      } catch (error) {
        close();
        throw error;
      } finally {
        busy = false;
      }
    };
    const close = () => {
      if (closed) return;
      closed = true;
      bound.delete(index);
      key.fill(0);
      try {
        physical?.close();
      } finally {
        scratch.close();
      }
    };
    const index = Object.freeze({
      append(sql: string, args: readonly SQLInputValue[], expectedChanges: number) {
        return append('run', sql, args, expectedChanges);
      },
      appendCheck(sql: string, args: readonly SQLInputValue[], expectedPresent: boolean) {
        return append('check', sql, args, Number(expectedPresent));
      },
      async seal() {
        current();
        if (busy || sealed || used) fail();
        busy = true;
        try {
          guard();
          Reflect.apply(nativeExec, scratch.db, ['COMMIT']);
          building = false;
          guard();
          const path = Reflect.apply(location, scratch.db, []) as string;
          if (!path) fail();
          physical = captureRecordHeadPhysical([path], [dirname(path)]);
          await cooperate(
            (function* () {
              const quantum = { bytes: 0, pieces: 0 };
              for (let position = 0; position < count; position++) {
                const { row, args } = read(position);
                if (row.signature !== (yield* sign(row, args, quantum))) fail();
              }
            })(),
          );
          guard();
          if (get(membership)!.n !== count || get(argumentMembership)!.n !== argumentCount) fail();
          guard();
          sealed = true;
        } catch (error) {
          close();
          throw error;
        } finally {
          busy = false;
        }
      },
      *sql(): Generator<string> {
        current();
        if (!sealed || used) fail();
        for (let position = 0; position < count; position++) {
          current();
          const row = get(selected, position);
          if (row?.position !== position || typeof row.sql !== 'string') fail();
          yield row!.sql as string;
        }
        current();
      },
      *inspect(): Generator<{
        sql: string;
        args: SQLInputValue[];
        mode: 'run' | 'check';
        expected: number;
      }> {
        current();
        if (!sealed || used || db.isTransaction) fail();
        for (let position = 0; position < count; position++) {
          const { row, args } = read(position);
          yield {
            sql: row.sql,
            args: args.map(value),
            mode: row.mode as 'run' | 'check',
            expected: row.expected,
          };
          current();
        }
        if (get(membership)!.n !== count || get(argumentMembership)!.n !== argumentCount) fail();
        current();
      },
      *consume(): Generator<{
        sql: string;
        args: SQLInputValue[];
        mode: 'run' | 'check';
        expected: number;
      }> {
        current();
        if (!sealed || used || !db.isTransaction) fail();
        used = true;
        for (let position = 0; position < count; position++) {
          const { row, args } = read(position);
          yield {
            sql: row.sql,
            args: args.map(value),
            mode: row.mode as 'run' | 'check',
            expected: row.expected,
          };
          current();
        }
        if (get(membership)!.n !== count || get(argumentMembership)!.n !== argumentCount) fail();
        current();
      },
      close,
    });
    bound.set(index, db);
    return index;
  } catch (error) {
    key.fill(0);
    physical?.close();
    scratch.close();
    throw error;
  }
}
