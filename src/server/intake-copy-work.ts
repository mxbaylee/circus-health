/** Copy preparation uses the same steps for synchronous internal callers and
 * cooperative profile creation. No step driver owns accepted authority. */
import { DatabaseSync, StatementSync, type SQLInputValue } from 'node:sqlite';
import {
  managedDatabaseMethodEpoch,
  managedDatabaseDataMethod,
  prepareManagedDatabaseCallbackBarrier,
  withoutManagedDatabaseCallbacks,
  currentTransactionToken,
} from './database.ts';

const nativePrepare = DatabaseSync.prototype.prepare;
const nativeExec = DatabaseSync.prototype.exec;
const nativeAll = StatementSync.prototype.all,
  nativeIterate = StatementSync.prototype.iterate,
  nativeReadBigInts = StatementSync.prototype.setReadBigInts;
const nativeGet = (() => {
  const db = new DatabaseSync(':memory:');
  try {
    return Object.getPrototypeOf(db.prepare('SELECT 1')).get as StatementSync['get'];
  } finally {
    db.close();
  }
})();
const nativeIterator = (() => {
  const db = new DatabaseSync(':memory:');
  try {
    const statement = Reflect.apply(nativePrepare, db, ['SELECT 1']) as StatementSync,
      iterator = Reflect.apply(nativeIterate, statement, []),
      prototype = Object.getPrototypeOf(iterator),
      next = Object.getOwnPropertyDescriptor(prototype, 'next')?.value,
      finish = Object.getOwnPropertyDescriptor(prototype, 'return')?.value;
    if (typeof next !== 'function' || typeof finish !== 'function')
      throw Error('Intake copy native iterator unavailable');
    Reflect.apply(finish, iterator, []);
    return { next, finish };
  } finally {
    db.close();
  }
})();

/** Read actual native rows, never mutable public statement/iterator methods.
 * Compilation still runs the installed SQL policy before cached execution. */
export function intakeCopyNativeSelect(
  db: DatabaseSync,
  sql: string,
  checkpoint: () => void = () => {},
) {
  if (!/^\s*SELECT\b/i.test(sql)) throw Error('Copy native read requires SELECT');
  const managed = !!managedDatabaseMethodEpoch(db);
  if (managed) prepareManagedDatabaseCallbackBarrier(db);
  checkpoint();
  const statement = Reflect.apply(nativePrepare, db, [sql]) as StatementSync;
  checkpoint();
  const read = <T>(run: () => T) => (managed ? withoutManagedDatabaseCallbacks(db, run) : run());
  return Object.freeze({
    get(...args: SQLInputValue[]): ReturnType<StatementSync['get']> {
      return read(() => Reflect.apply(nativeGet, statement, args));
    },
    all(...args: SQLInputValue[]): ReturnType<StatementSync['all']> {
      return read(() => Reflect.apply(nativeAll, statement, args));
    },
    *iterate(...args: SQLInputValue[]): ReturnType<StatementSync['iterate']> {
      let iterator!: ReturnType<StatementSync['iterate']>;
      read(() => {
        iterator = Reflect.apply(nativeIterate, statement, args);
      });
      try {
        for (;;) {
          const item = read(
            () =>
              Reflect.apply(nativeIterator.next, iterator, []) as IteratorResult<
                NonNullable<ReturnType<StatementSync['get']>>
              >,
          );
          if (item.done) return;
          yield item.value;
        }
      } finally {
        read(() => Reflect.apply(nativeIterator.finish, iterator, []));
      }
    },
  });
}

/** Original read interval, not a refreshable equality result. Native statements
 * and callback barriers prevent a forged or transient SQL stamp from renewing it. */
export function captureIntakeCopyReadInterval(
  db: DatabaseSync,
  profileId: string,
): (transaction?: object) => void {
  prepareManagedDatabaseCallbackBarrier(db);
  const methods = managedDatabaseMethodEpoch(db),
    prepare = managedDatabaseDataMethod(db, 'prepare'),
    exec = managedDatabaseDataMethod(db, 'exec');
  if (!methods || prepare !== nativePrepare || exec !== nativeExec || db.isTransaction)
    throw Error('Copy read interval requires native managed database');
  const total = Reflect.apply(nativePrepare, db, ['SELECT total_changes() AS n']) as StatementSync;
  Reflect.apply(nativeReadBigInts, total, [true]);
  const acquiredChanges = withoutManagedDatabaseCallbacks(
    db,
    () => Reflect.apply(nativeGet, total, [])!.n,
  );
  const main = Reflect.apply(nativePrepare, db, ['PRAGMA main.schema_version']) as StatementSync,
    temp = Reflect.apply(nativePrepare, db, ['PRAGMA temp.schema_version']) as StatementSync,
    peer = Reflect.apply(nativePrepare, db, ['PRAGMA main.data_version']) as StatementSync,
    stamp = Reflect.apply(nativePrepare, db, [
      "SELECT total_changes() changes,(SELECT value FROM main.app_meta WHERE key='owner_profile_id') owner,(SELECT count(*) FROM temp.sqlite_schema WHERE type IN ('table','view') AND name IN (SELECT name FROM main.sqlite_schema)) shadows",
    ]) as StatementSync;
  Reflect.apply(nativeReadBigInts, stamp, [true]);
  const read = (transaction?: object) => {
    if (
      !db.isOpen ||
      (db.isTransaction && (!transaction || currentTransactionToken(db) !== transaction)) ||
      managedDatabaseMethodEpoch(db) !== methods ||
      managedDatabaseDataMethod(db, 'prepare') !== prepare ||
      managedDatabaseDataMethod(db, 'exec') !== exec
    )
      throw Error('Copy original read interval changed');
    try {
      return withoutManagedDatabaseCallbacks(db, () => {
        const row = Reflect.apply(nativeGet, stamp, [])!;
        if (row.changes !== acquiredChanges) throw Error('Copy original read interval changed');
        if (row.owner !== profileId || row.shadows !== 0n)
          throw Error('Copy original read owner or shadow schema changed');
        return [
          row.changes,
          Reflect.apply(nativeGet, peer, [])!.data_version,
          Reflect.apply(nativeGet, main, [])!.schema_version,
          Reflect.apply(nativeGet, temp, [])!.schema_version,
        ].join(':');
      });
    } catch (cause) {
      throw Error('Copy original read interval changed', { cause });
    }
  };
  const original = read();
  return (transaction) => {
    if (read(transaction) !== original) throw Error('Copy original read interval changed');
  };
}
export function finishIntakeCopySteps<T>(steps: Generator<void, T>): T {
  try {
    for (;;) {
      const next = steps.next();
      if (next.done) return next.value;
    }
  } finally {
    steps.return(undefined as never);
  }
}

export async function finishIntakeCopyStepsAsync<T>(
  steps: Generator<void, T>,
  signal?: AbortSignal,
): Promise<T> {
  try {
    for (;;) {
      signal?.throwIfAborted();
      const next = steps.next();
      if (next.done) return next.value;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    steps.return(undefined as never);
  }
}
