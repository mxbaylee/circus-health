import { createHash, createHmac, randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { DatabaseSync, StatementSync, type SQLInputValue } from 'node:sqlite';
import { disposableSqlite } from './disposable-sqlite.ts';
import { captureRecordHeadPhysical } from './record-head-physical.ts';

const prepare = DatabaseSync.prototype.prepare,
  nativeExec = DatabaseSync.prototype.exec,
  nativeGet = StatementSync.prototype.get,
  nativeRun = StatementSync.prototype.run,
  location = DatabaseSync.prototype.location;
const bound = new WeakMap<object, DatabaseSync>();
export function recordPreparedIndexBoundTo(db: DatabaseSync, index: object): boolean {
  return bound.get(index) === db;
}
type Scalar = { kind: string; value: string | Uint8Array | null };
type StoredScalar = { ordinal: number; kind: string; units: number | null; parts: number };
type Header = { position: number; sql: string; mode: string; expected: number; arguments: number };
type HashQuantum = { bytes: number; pieces: number };
const HASH_BYTES = 16384,
  HASH_PIECES = 64;
function fail(): never {
  throw Error('Prepared record index changed, escaped or expired');
}
const get = (statement: StatementSync, ...args: SQLInputValue[]) =>
  Reflect.apply(nativeGet, statement, args) as ReturnType<StatementSync['get']>;
const run = (statement: StatementSync, ...args: SQLInputValue[]) =>
  Reflect.apply(nativeRun, statement, args) as ReturnType<StatementSync['run']>;
function* exactSqliteText(value: string, quantum: { scanned: number }): Generator<void> {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (++index === value.length) fail();
      const following = value.charCodeAt(index);
      if (following < 0xdc00 || following > 0xdfff) fail();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) fail();
    if (++quantum.scanned === 8192) {
      quantum.scanned = 0;
      yield;
    }
  }
}
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
function* textParts(value: string): Generator<Uint8Array> {
  for (let offset = 0; offset < value.length; offset += 8192)
    yield Buffer.from(value.slice(offset, offset + 8192), 'utf16le');
}
function* scalarParts(input: Scalar): Generator<Uint8Array> {
  if (typeof input.value === 'string') {
    yield* textParts(input.value);
  } else if (input.value instanceof Uint8Array) {
    for (let offset = 0; offset < input.value.length; offset += HASH_BYTES)
      yield input.value.subarray(offset, offset + HASH_BYTES);
  }
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
        'CREATE TABLE arguments(position INTEGER NOT NULL,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,units INTEGER,parts INTEGER NOT NULL,PRIMARY KEY(position,ordinal)) WITHOUT ROWID;' +
        'CREATE TABLE argument_parts(position INTEGER NOT NULL,ordinal INTEGER NOT NULL,part INTEGER NOT NULL,value BLOB NOT NULL,PRIMARY KEY(position,ordinal,part)) WITHOUT ROWID;',
    );
    Reflect.apply(nativeExec, scratch.db, ['BEGIN']);
    building = true;
    const statement = (sql: string) => Reflect.apply(prepare, scratch.db, [sql]) as StatementSync,
      stamp = statement('SELECT total_changes() AS n'),
      schema = statement('PRAGMA main.schema_version'),
      peer = statement('PRAGMA main.data_version'),
      insert = statement('INSERT INTO entries VALUES(?,?,?,?,?,?)'),
      insertArg = statement('INSERT INTO arguments VALUES(?,?,?,?,?)'),
      insertPart = statement('INSERT INTO argument_parts VALUES(?,?,?,?)'),
      selected = statement('SELECT * FROM entries WHERE position=?'),
      selectedArgs = statement(
        'SELECT ordinal,kind,units,parts FROM arguments WHERE position=? AND ordinal=?',
      ),
      selectedParts = statement(
        'SELECT part,value FROM argument_parts WHERE position=? AND ordinal=? AND part=?',
      ),
      membership = statement('SELECT count(*) AS n FROM entries'),
      argumentMembership = statement('SELECT count(*) AS n FROM arguments'),
      partMembership = statement('SELECT count(*) AS n FROM argument_parts');
    stamp.setReadBigInts(true);
    const originalSchema = get(schema)!.schema_version,
      originalPeer = get(peer)!.data_version;
    let argumentCount = 0,
      partCount = 0;
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
    type SignedArgument = { kind: string; units: number | null; parts: Iterable<Uint8Array> };
    const sign = function* (
      header: Header,
      args: Iterable<SignedArgument>,
      quantum: HashQuantum,
    ): Generator<void, string> {
      const hmac = createHmac('sha256', key);
      const piece = function* (input: Uint8Array): Generator<void, void> {
        for (let offset = 0; offset < input.length; offset += HASH_BYTES) {
          const end = Math.min(offset + HASH_BYTES, input.length),
            bytes = end - offset;
          if (quantum.bytes + bytes > HASH_BYTES) {
            yield;
            quantum.bytes = quantum.pieces = 0;
          }
          hmac.update(input.subarray(offset, end));
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
      for (const part of textParts(header.sql)) yield* piece(part);
      for (const arg of args) {
        yield* piece(Buffer.from(JSON.stringify([arg.kind, arg.units])));
        for (const part of arg.parts) yield* piece(part);
      }
      return hmac.digest('hex');
    };
    // Private native reads are callback-free. The caller checks each signing
    // quantum or complete decoded row before exposing it or yielding control.
    const storedArgs = function* (position: number, count: number): Generator<SignedArgument> {
      for (let ordinal = 0; ordinal < count; ordinal++) {
        const meta = get(selectedArgs, position, ordinal) as unknown as StoredScalar | undefined;
        if (!meta) fail();
        if (meta.ordinal !== ordinal || !Number.isSafeInteger(meta.parts) || meta.parts < 0) fail();
        const validKind = ['null', 'string', 'number', 'bigint', 'blob'].includes(meta.kind);
        if (!validKind) fail();
        if (meta.kind === 'null') {
          if (meta.units !== null || meta.parts !== 0) fail();
        } else if (!Number.isSafeInteger(meta.units) || meta.units! < 0) fail();
        const bytes = meta.kind === 'null' ? 0 : meta.units! * (meta.kind === 'blob' ? 1 : 2);
        if (
          !Number.isSafeInteger(bytes) ||
          meta.parts !== Math.ceil(bytes / HASH_BYTES) ||
          meta.parts > partCount
        )
          fail();
        const argOrdinal = ordinal;
        yield {
          kind: meta.kind,
          units: meta.units,
          parts: (function* () {
            let seen = 0;
            for (let part = 0; part < meta.parts; part++) {
              const item = get(selectedParts, position, argOrdinal, part);
              if (!item) fail();
              const value = item.value;
              if (
                item.part !== part ||
                !(value instanceof Uint8Array) ||
                value.length !== Math.min(HASH_BYTES, bytes - seen)
              )
                fail();
              seen += value.length;
              yield value;
            }
            if (seen !== bytes) fail();
          })(),
        };
      }
    };
    const read = (position: number) => {
      current();
      const row = get(selected, position) as unknown as Header & { signature: string };
      if (!row || row.position !== position || !['run', 'check'].includes(row.mode)) fail();
      current();
      return row;
    };
    const decodedArgs = (position: number, count: number): SQLInputValue[] => {
      const args: SQLInputValue[] = [];
      for (const arg of storedArgs(position, count)) {
        if (arg.kind === 'null') {
          args.push(null);
          continue;
        }
        const bytes = arg.units! * (arg.kind === 'blob' ? 1 : 2),
          value = new Uint8Array(bytes);
        let offset = 0;
        for (const part of arg.parts) {
          value.set(part, offset);
          offset += part.length;
        }
        if (offset !== bytes) fail();
        if (arg.kind === 'blob') args.push(value);
        else {
          const text = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
            'utf16le',
          );
          if (arg.kind === 'string') args.push(text);
          else if (arg.kind === 'bigint') args.push(BigInt(text));
          else {
            const number = Number(text);
            if (String(number) !== text && !(Object.is(number, -0) && text === '-0')) fail();
            args.push(number);
          }
        }
      }
      return args;
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
        // Mutable BLOB bytes enter private scratch before the first yield;
        // immutable text is scanned and staged at bounded checkpoints.
        const args = input.map(scalar),
          blobDigests: Array<string | undefined> = [],
          header: Header = {
            position: count,
            sql,
            mode,
            expected,
            arguments: args.length,
          };
        for (let ordinal = 0; ordinal < args.length; ordinal++) {
          const arg = args[ordinal]!,
            units = arg.value?.length ?? null,
            parts = Math.ceil(((units ?? 0) * (arg.kind === 'blob' ? 1 : 2)) / HASH_BYTES);
          if (run(insertArg, count, ordinal, arg.kind, units, parts).changes !== 1) fail();
          changes++;
          argumentCount++;
          if (arg.kind === 'blob') {
            let part = 0;
            const digest = createHash('sha256');
            for (const bytes of scalarParts(arg)) {
              digest.update(bytes);
              if (run(insertPart, count, ordinal, part++, bytes).changes !== 1) fail();
              changes++;
              partCount++;
            }
            if (part !== parts) fail();
            blobDigests[ordinal] = digest.digest('hex');
          }
        }
        await cooperate(
          (function* () {
            const textQuantum = { scanned: 0 },
              writeQuantum: HashQuantum = { bytes: 0, pieces: 0 };
            yield* exactSqliteText(sql, textQuantum);
            for (let ordinal = 0; ordinal < args.length; ordinal++) {
              const arg = args[ordinal]!;
              if (arg.kind === 'blob') continue;
              if (arg.kind === 'string') yield* exactSqliteText(arg.value as string, textQuantum);
              let part = 0;
              for (const bytes of scalarParts(arg)) {
                if (writeQuantum.bytes + bytes.byteLength > HASH_BYTES) {
                  yield;
                  writeQuantum.bytes = writeQuantum.pieces = 0;
                }
                if (run(insertPart, count, ordinal, part++, bytes).changes !== 1) fail();
                changes++;
                partCount++;
                writeQuantum.bytes += bytes.byteLength;
              }
              const units = arg.value?.length ?? null,
                parts = Math.ceil(((units ?? 0) * 2) / HASH_BYTES);
              if (part !== parts) fail();
              // Private scalar staging shares a quantum across small arguments.
              // Callback-capable checks still bracket every actual host yield.
              if (writeQuantum.bytes === HASH_BYTES || ++writeQuantum.pieces === HASH_PIECES) {
                yield;
                writeQuantum.bytes = writeQuantum.pieces = 0;
              }
            }
          })(),
        );
        const retained = [...storedArgs(count, args.length)],
          source: SignedArgument[] = args.map((arg, ordinal) => {
            const units = arg.value?.length ?? null;
            if (arg.kind !== 'blob') return { kind: arg.kind, units, parts: scalarParts(arg) };
            const staged = retained[ordinal],
              expectedDigest = blobDigests[ordinal];
            if (!staged || staged.kind !== 'blob' || staged.units !== units || !expectedDigest)
              fail();
            return {
              kind: 'blob',
              units,
              parts: (function* () {
                const digest = createHash('sha256');
                for (const part of staged.parts) {
                  digest.update(part);
                  yield part;
                }
                if (digest.digest('hex') !== expectedDigest) fail();
              })(),
            };
          });
        const signature = await cooperate(sign(header, source, { bytes: 0, pieces: 0 }));
        if (run(insert, count, sql, mode, expected, args.length, signature).changes !== 1) fail();
        changes++;
        count++;
        if (
          (await cooperate(
            sign(read(header.position), storedArgs(header.position, args.length), {
              bytes: 0,
              pieces: 0,
            }),
          )) !== signature
        )
          fail();
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
                const row = read(position);
                if (
                  row.signature !== (yield* sign(row, storedArgs(position, row.arguments), quantum))
                )
                  fail();
              }
            })(),
          );
          guard();
          if (
            get(membership)!.n !== count ||
            get(argumentMembership)!.n !== argumentCount ||
            get(partMembership)!.n !== partCount
          )
            fail();
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
          const row = read(position);
          const args = decodedArgs(position, row.arguments);
          current();
          yield {
            sql: row.sql,
            args,
            mode: row.mode as 'run' | 'check',
            expected: row.expected,
          };
          current();
        }
        if (
          get(membership)!.n !== count ||
          get(argumentMembership)!.n !== argumentCount ||
          get(partMembership)!.n !== partCount
        )
          fail();
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
          const row = read(position);
          const args = decodedArgs(position, row.arguments);
          current();
          yield {
            sql: row.sql,
            args,
            mode: row.mode as 'run' | 'check',
            expected: row.expected,
          };
          current();
        }
        if (
          get(membership)!.n !== count ||
          get(argumentMembership)!.n !== argumentCount ||
          get(partMembership)!.n !== partCount
        )
          fail();
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
