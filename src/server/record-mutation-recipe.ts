import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync, StatementSync, type SQLInputValue } from 'node:sqlite';
import { disposableSqlite } from './disposable-sqlite.ts';
import { captureRecordHeadPhysical } from './record-head-physical.ts';
import { dirname } from 'node:path';
import { setImmediate as yieldHost } from 'node:timers/promises';

const prepare = DatabaseSync.prototype.prepare,
  run = StatementSync.prototype.run,
  get = StatementSync.prototype.get,
  all = StatementSync.prototype.all,
  iterate = StatementSync.prototype.iterate,
  location = DatabaseSync.prototype.location,
  readBigInts = StatementSync.prototype.setReadBigInts,
  descriptor = Object.getOwnPropertyDescriptor;
type Argument = { kind: string; value: string | Uint8Array | null };
export type RecordMutationOutput = 'none' | 'changes' | 'rowid';
interface RecipeRow {
  sequence: number;
  sql: string;
  arguments: number;
  changes: string;
  rowid: string | null;
  delta: string;
  signature: string;
}
interface Capture {
  statement(sql: string, output: RecordMutationOutput): StatementSync;
}
const active = new WeakMap<DatabaseSync, Capture>();
const recipes = new WeakMap<object, DatabaseSync>();
/** Provenance only; the consuming owner still proves its operation/evidence. */
export function recordMutationRecipeBoundTo(db: DatabaseSync, recipe: object): boolean {
  return recipes.get(recipe) === db;
}
const fail = (): never => {
  throw Error('Record mutation recipe changed, escaped or was already consumed');
};
function argument(value: SQLInputValue): Argument {
  if (value === null) return { kind: 'null', value: null };
  if (typeof value === 'string') return { kind: 'string', value };
  if (typeof value === 'number')
    return { kind: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
  if (typeof value === 'bigint') return { kind: 'bigint', value: String(value) };
  if (ArrayBuffer.isView(value))
    return Object.freeze({
      kind: 'blob',
      value: Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    });
  return fail();
}
function value(arg: Argument): SQLInputValue {
  switch (arg.kind) {
    case 'null':
      if (arg.value !== null) fail();
      return null;
    case 'string':
      if (typeof arg.value !== 'string') fail();
      return arg.value as string;
    case 'number':
      if (typeof arg.value !== 'string') fail();
      return Number(arg.value);
    case 'bigint':
      if (typeof arg.value !== 'string') fail();
      return BigInt(arg.value as string);
    case 'blob':
      if (!(arg.value instanceof Uint8Array)) fail();
      return Buffer.from(arg.value as Uint8Array);
    default:
      return fail();
  }
}

/** Reachable application DML opts into capture; arbitrary native statements are
 * not enrolled. This transport grants neither transaction nor acceptance authority. */
export function recordMutationStatement(
  db: DatabaseSync,
  sql: string,
  output: RecordMutationOutput = 'none',
): StatementSync {
  return active.get(db)?.statement(sql, output) ?? db.prepare(sql);
}

/** Ordered changed-scope SQL/arguments, never a table or document snapshot.
 * The owning publication plan must bind the recipe to its genuine operation,
 * original evidence and exact changed-row result before it can be replayed. */
export function createRecordMutationRecipe(db: DatabaseSync) {
  const scratch = disposableSqlite('circus-record-mutation-recipe-'),
    key = randomBytes(32);
  let closed = false,
    failed = false,
    sealed = false,
    used = false,
    capturing = false,
    executing = false,
    count = 0,
    expectedWrites = 0n;
  let replayPhysical: ReturnType<typeof captureRecordHeadPhysical> | undefined;
  let replayVerified = false;
  try {
    scratch.db.exec(
      'CREATE TABLE recipe(sequence INTEGER PRIMARY KEY,sql TEXT NOT NULL,arguments INTEGER NOT NULL,changes TEXT NOT NULL,rowid TEXT,delta TEXT NOT NULL,signature TEXT NOT NULL); CREATE TABLE arguments(sequence INTEGER NOT NULL,position INTEGER NOT NULL,kind TEXT NOT NULL,value,PRIMARY KEY(sequence,position));',
    );
    const stamp = scratch.db.prepare('SELECT total_changes() AS n'),
      peer = scratch.db.prepare('PRAGMA data_version'),
      schema = scratch.db.prepare('PRAGMA schema_version');
    let sourceStamp = Reflect.apply(prepare, db, ['SELECT total_changes() AS n']);
    const sourceSql = descriptor(sourceStamp, 'sourceSQL'),
      nativeSourceSql = sourceSql?.get;
    if (typeof nativeSourceSql !== 'function' || sourceSql?.configurable) return fail();
    Reflect.apply(readBigInts, stamp, [true]);
    Reflect.apply(readBigInts, sourceStamp, [true]);
    const read = (statement: StatementSync) => Reflect.apply(get, statement, []);
    const originalPeer = read(peer)!.data_version,
      originalSchema = read(schema)!.schema_version,
      insert = scratch.db.prepare('INSERT INTO recipe VALUES(?,?,?,?,?,?,?)'),
      insertArgument = scratch.db.prepare('INSERT INTO arguments VALUES(?,?,?,?)'),
      rows = scratch.db.prepare('SELECT * FROM recipe ORDER BY sequence'),
      argumentsFor = scratch.db.prepare(
        'SELECT kind,value FROM arguments WHERE sequence=? ORDER BY position',
      );
    const current = () => {
      if (
        closed ||
        failed ||
        !db.isOpen ||
        read(peer)!.data_version !== originalPeer ||
        read(schema)!.schema_version !== originalSchema ||
        read(stamp)!.n !== expectedWrites ||
        (replayPhysical && !replayPhysical.current())
      )
        fail();
    };
    const sign = (row: Omit<RecipeRow, 'signature'>, args: readonly Argument[]) => {
      const digest = createHmac('sha256', key).update(JSON.stringify(row));
      for (const arg of args) {
        digest.update(JSON.stringify([arg.kind, arg.value === null ? null : arg.value.length]));
        if (arg.value !== null) digest.update(arg.value);
      }
      return digest.digest('hex');
    };
    const capture: Capture = {
      statement(sql, output) {
        current();
        if (!capturing || sealed || executing || active.get(db) !== capture) fail();
        if (!['none', 'changes', 'rowid'].includes(output)) fail();
        // Genuine native compilation applies the installed prepare-time policy.
        let statement: StatementSync;
        executing = true;
        try {
          const before = Reflect.apply(get, sourceStamp, []).n;
          statement = Reflect.apply(prepare, db, [sql]);
          if (Reflect.apply(get, sourceStamp, []).n !== before) fail();
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          executing = false;
        }
        current();
        if (!capturing || sealed || active.get(db) !== capture) fail();
        return Object.freeze({
          sourceSQL: statement.sourceSQL,
          run(...input: SQLInputValue[]) {
            current();
            if (!capturing || sealed || executing || active.get(db) !== capture) fail();
            const args = input.map(argument),
              copied = args.map(value);
            executing = true;
            try {
              const before = Reflect.apply(get, sourceStamp, []).n as bigint,
                result = Reflect.apply(run, statement, copied),
                after = Reflect.apply(get, sourceStamp, []).n as bigint,
                row = {
                  sequence: count,
                  sql: statement.sourceSQL,
                  arguments: args.length,
                  changes: String(result.changes),
                  rowid: output === 'rowid' ? String(result.lastInsertRowid) : null,
                  delta: String(after - before),
                };
              current();
              for (let position = 0; position < args.length; position++) {
                const arg = args[position]!;
                if (
                  Reflect.apply(run, insertArgument, [count, position, arg.kind, arg.value])
                    .changes !== 1
                )
                  fail();
                expectedWrites++;
              }
              if (
                Reflect.apply(run, insert, [
                  count,
                  row.sql,
                  args.length,
                  row.changes,
                  row.rowid,
                  row.delta,
                  sign(row, args),
                ]).changes !== 1
              )
                fail();
              expectedWrites++;
              count++;
              current();
              // last_insert_rowid is connection state, not a write result for
              // UPDATE/DELETE. Only an explicitly consuming callsite pins it.
              return Object.freeze({
                get changes() {
                  current();
                  if (!capturing || active.get(db) !== capture) fail();
                  if (output === 'none') {
                    failed = true;
                    fail();
                  }
                  return result.changes;
                },
                get lastInsertRowid() {
                  current();
                  if (!capturing || active.get(db) !== capture) fail();
                  if (output !== 'rowid') {
                    failed = true;
                    fail();
                  }
                  return result.lastInsertRowid;
                },
              });
            } catch (error) {
              failed = true;
              throw error;
            } finally {
              executing = false;
            }
          },
        }) as unknown as StatementSync;
      },
    };
    const probe = Reflect.apply(iterate, rows, []),
      next = descriptor(Object.getPrototypeOf(probe), 'next')?.value,
      finish = descriptor(Object.getPrototypeOf(probe), 'return')?.value;
    if (typeof next !== 'function' || typeof finish !== 'function') fail();
    Reflect.apply(finish, probe, []);
    const checked = function* (
      authenticate = true,
    ): Generator<{ row: RecipeRow; args: SQLInputValue[] }> {
      current();
      let visited = 0;
      const iterator = Reflect.apply(iterate, rows, []);
      try {
        while (true) {
          const item = Reflect.apply(next, iterator, []) as IteratorResult<Record<string, unknown>>;
          if (item.done) break;
          const raw = item.value;
          current();
          const row = raw as unknown as RecipeRow,
            args = Reflect.apply(all, argumentsFor, [row.sequence]) as unknown as Argument[];
          const { signature, ...header } = row;
          if (
            row.sequence !== visited++ ||
            args.length !== row.arguments ||
            (authenticate && sign(header, args) !== signature)
          )
            fail();
          yield { row, args: args.map(value) };
          current();
        }
      } finally {
        Reflect.apply(finish, iterator, []);
      }
      if (visited !== count) fail();
      current();
    };
    const recipe = Object.freeze({
      capture<T>(fn: () => T): T {
        current();
        if (capturing || sealed || active.has(db) || !db.isTransaction) fail();
        active.set(db, capture);
        capturing = true;
        try {
          const result = fn();
          if (
            result &&
            (typeof result === 'object' || typeof result === 'function') &&
            ('then' in result || Symbol.iterator in result || Symbol.asyncIterator in result)
          )
            fail();
          current();
          sealed = true;
          return result;
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          capturing = false;
          if (active.get(db) === capture) active.delete(db);
        }
      },
      *sql(): Generator<string> {
        if (!sealed || used) fail();
        for (const { row } of checked()) yield row.sql;
      },
      writes(): bigint {
        if (!sealed || used) fail();
        let writes = 0n;
        for (const { row } of checked()) {
          if (!/^(0|[1-9][0-9]*)$/.test(row.delta)) fail();
          writes += BigInt(row.delta);
        }
        return writes;
      },
      async prepareReplay(): Promise<void> {
        current();
        if (!sealed || used || replayPhysical) fail();
        // Barrier preparation rearms authorization and expires older bytecode.
        // Recompile before the final physical proof, never during replay.
        sourceStamp = Reflect.apply(prepare, db, ['SELECT total_changes() AS n']);
        Reflect.apply(readBigInts, sourceStamp, [true]);
        Reflect.apply(get, sourceStamp, []);
        current();
        const path = Reflect.apply(location, scratch.db, []) as string;
        if (!path) fail();
        replayPhysical = captureRecordHeadPhysical([path], [dirname(path)]);
        try {
          for (const { row, args: input } of checked(false)) {
            const { signature, ...header } = row,
              args = input.map(argument),
              digest = createHmac('sha256', key).update(JSON.stringify(header));
            for (const arg of args) {
              digest.update(
                JSON.stringify([arg.kind, arg.value === null ? null : arg.value.length]),
              );
              if (arg.value === null) continue;
              for (let offset = 0; offset < arg.value.length;) {
                current();
                let end = Math.min(offset + 4096, arg.value.length);
                if (
                  typeof arg.value === 'string' &&
                  end < arg.value.length &&
                  /[\uD800-\uDBFF]/.test(arg.value[end - 1]!)
                )
                  end--;
                digest.update(
                  typeof arg.value === 'string'
                    ? arg.value.slice(offset, end)
                    : arg.value.subarray(offset, end),
                );
                offset = end;
                await yieldHost();
                current();
              }
            }
            if (digest.digest('hex') !== signature) fail();
          }
          current();
          replayVerified = true;
        } catch (error) {
          failed = true;
          throw error;
        }
      },
      replay(resolve: (sql: string) => StatementSync): void {
        if (!sealed || used || !db.isTransaction || (replayPhysical && !replayVerified)) fail();
        used = true;
        for (const { row, args } of checked(!replayPhysical)) {
          const before = Reflect.apply(get, sourceStamp, []).n as bigint,
            statement = resolve(row.sql);
          // This native accessor also rejects non-native resolver facades.
          if (Reflect.apply(nativeSourceSql, statement, []) !== row.sql) fail();
          current();
          const result = Reflect.apply(run, statement, args),
            after = Reflect.apply(get, sourceStamp, []).n as bigint;
          if (
            String(result.changes) !== row.changes ||
            (row.rowid !== null && String(result.lastInsertRowid) !== row.rowid) ||
            String(after - before) !== row.delta
          )
            fail();
        }
      },
      close() {
        if (closed) return;
        if (capturing || executing) fail();
        closed = true;
        recipes.delete(recipe);
        if (active.get(db) === capture) active.delete(db);
        key.fill(0);
        try {
          replayPhysical?.close();
        } finally {
          scratch.close();
        }
      },
    });
    recipes.set(recipe, db);
    return recipe;
  } catch (error) {
    key.fill(0);
    scratch.close();
    throw error;
  }
}
