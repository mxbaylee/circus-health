import { createHmac, randomBytes } from 'node:crypto';
import { DatabaseSync, StatementSync, type SQLInputValue } from 'node:sqlite';
import { disposableSqlite } from './disposable-sqlite.ts';

const prepare = DatabaseSync.prototype.prepare,
  run = StatementSync.prototype.run,
  get = StatementSync.prototype.get,
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
  try {
    scratch.db.exec(
      'CREATE TABLE recipe(sequence INTEGER PRIMARY KEY,sql TEXT NOT NULL,arguments INTEGER NOT NULL,changes TEXT NOT NULL,rowid TEXT,delta TEXT NOT NULL,signature TEXT NOT NULL); CREATE TABLE arguments(sequence INTEGER NOT NULL,position INTEGER NOT NULL,kind TEXT NOT NULL,value,PRIMARY KEY(sequence,position));',
    );
    const stamp = scratch.db.prepare('SELECT total_changes() AS n'),
      peer = scratch.db.prepare('PRAGMA data_version'),
      schema = scratch.db.prepare('PRAGMA schema_version'),
      sourceStamp = Reflect.apply(prepare, db, ['SELECT total_changes() AS n']);
    const sourceSql = descriptor(sourceStamp, 'sourceSQL'),
      nativeSourceSql = sourceSql?.get;
    if (typeof nativeSourceSql !== 'function' || sourceSql?.configurable) return fail();
    stamp.setReadBigInts(true);
    sourceStamp.setReadBigInts(true);
    const originalPeer = peer.get()!.data_version,
      originalSchema = schema.get()!.schema_version,
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
        peer.get()!.data_version !== originalPeer ||
        schema.get()!.schema_version !== originalSchema ||
        stamp.get()!.n !== expectedWrites
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
                if (insertArgument.run(count, position, arg.kind, arg.value).changes !== 1) fail();
                expectedWrites++;
              }
              if (
                insert.run(
                  count,
                  row.sql,
                  args.length,
                  row.changes,
                  row.rowid,
                  row.delta,
                  sign(row, args),
                ).changes !== 1
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
    const checked = function* (): Generator<{ row: RecipeRow; args: SQLInputValue[] }> {
      current();
      let visited = 0;
      for (const raw of rows.iterate()) {
        current();
        const row = raw as unknown as RecipeRow,
          args = argumentsFor.all(row.sequence) as unknown as Argument[];
        const { signature, ...header } = row;
        if (
          row.sequence !== visited++ ||
          args.length !== row.arguments ||
          sign(header, args) !== signature
        )
          fail();
        yield { row, args: args.map(value) };
        current();
      }
      if (visited !== count) fail();
      current();
    };
    return Object.freeze({
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
      replay(resolve: (sql: string) => StatementSync): void {
        if (!sealed || used || !db.isTransaction) fail();
        used = true;
        for (const { row, args } of checked()) {
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
        if (active.get(db) === capture) active.delete(db);
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
