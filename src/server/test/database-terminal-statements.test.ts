import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, constants } from 'node:sqlite';
import {
  installManagedDatabaseAuthorization,
  installManagedDatabaseFunctionRegistration,
} from '../database.ts';
import {
  prepareTerminalStatements,
  withTerminalStatements,
  terminalStatement,
  terminalExecution,
  type PreparedTerminalStatements,
} from '../database-terminal-statements.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  installManagedDatabaseFunctionRegistration(db);
  installManagedDatabaseAuthorization(db);
  db.exec('CREATE TABLE fictional_values(n INTEGER); INSERT INTO fictional_values VALUES(7)');
  return db;
}
test('terminal transport rejects method accessors without invoking them', () => {
  const db = fixture();
  try {
    for (const name of [
      'function',
      'aggregate',
      'setAuthorizer',
      'prepare',
      'exec',
      'applyChangeset',
    ] as const) {
      const publication = prepareTerminalStatements(db, { statements: [{ sql: 'SELECT 1' }] }),
        descriptor = Object.getOwnPropertyDescriptor(db, name),
        original =
          descriptor?.value ?? Object.getOwnPropertyDescriptor(DatabaseSync.prototype, name)!.value;
      let calls = 0;
      Object.defineProperty(db, name, {
        configurable: true,
        get() {
          calls++;
          return original;
        },
      });
      try {
        assert.throws(
          () =>
            withTerminalStatements(db, publication, () => terminalStatement(db, 'SELECT 1').get()),
          /terminal|managed/i,
        );
        assert.equal(calls, 0, name + ' accessor must not run after preparation');
      } finally {
        if (descriptor) Object.defineProperty(db, name, descriptor);
        else Reflect.deleteProperty(db, name);
      }
    }
    assert.equal(db.isTransaction, false);
  } finally {
    db.close();
  }
});
test('terminal transport rejects changed inherited method descriptors without invoking them', () => {
  const db = fixture(),
    descriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, 'prepare')!;
  try {
    const publication = prepareTerminalStatements(db, { statements: [{ sql: 'SELECT 1' }] });
    let calls = 0;
    Object.defineProperty(DatabaseSync.prototype, 'prepare', {
      configurable: true,
      get() {
        calls++;
        return descriptor.value;
      },
    });
    assert.throws(
      () => withTerminalStatements(db, publication, () => terminalStatement(db, 'SELECT 1').get()),
      /terminal/,
    );
    assert.equal(calls, 0);
  } finally {
    Object.defineProperty(DatabaseSync.prototype, 'prepare', descriptor);
    db.close();
  }
});
test('fixed terminal statements retain genuine policy decisions without dispatch after preparation', () => {
  const db = fixture();
  try {
    let calls = 0;
    db.setAuthorizer(() => {
      calls++;
      return constants.SQLITE_OK;
    });
    const sql = 'SELECT n FROM fictional_values',
      publication = prepareTerminalStatements(db, {
        statements: [{ sql, bigInts: true }],
        executions: ['BEGIN IMMEDIATE', 'COMMIT'],
      });
    const before = calls;
    let retained: ReturnType<typeof terminalStatement> | undefined;
    withTerminalStatements(db, publication, () => {
      terminalExecution(db, 'BEGIN IMMEDIATE');
      retained = terminalStatement(db, sql, undefined, true);
      retained.setReadBigInts(true);
      assert.equal(retained.get()!.n, 7n);
      assert.throws(() => retained!.setReadBigInts(false), /terminal database statement/);
      assert.throws(() => terminalStatement(db, 'SELECT 11'), /unprepared/);
      terminalExecution(db, 'COMMIT');
    });
    assert.equal(calls, before);
    assert.throws(() => retained!.get(), /expired/);
    assert.throws(() => withTerminalStatements(db, publication, () => true), /expired/);
  } finally {
    db.close();
  }
});
test('denied preparation, multiple statements and foreign capabilities never acquire terminal permission', () => {
  const db = fixture(),
    foreign = fixture();
  try {
    assert.throws(() =>
      prepareTerminalStatements(db, { statements: [{ sql: 'SELECT 1; SELECT 2' }] }),
    );
    const publication = prepareTerminalStatements(db, { statements: [{ sql: 'SELECT 1' }] });
    assert.throws(() => withTerminalStatements(foreign, publication, () => true), /Foreign/);
    assert.throws(
      () => withTerminalStatements(db, {} as PreparedTerminalStatements, () => true),
      /Foreign/,
    );
    db.setAuthorizer(() => constants.SQLITE_DENY);
    assert.throws(() =>
      prepareTerminalStatements(db, { statements: [{ sql: 'SELECT n FROM fictional_values' }] }),
    );
    assert.throws(() => withTerminalStatements(db, publication, () => true), /expired/);
  } finally {
    db.close();
    foreign.close();
  }
});
test('schema replacement, method replacement and custom scalars refuse before entering their callbacks', () => {
  for (const mutation of ['schema', 'method', 'scalar'] as const) {
    const db = fixture();
    try {
      let calls = 0;
      db.function('fictional_scalar', () => {
        calls++;
        return 1;
      });
      const sql = 'SELECT fictional_scalar() AS n';
      const publication = prepareTerminalStatements(db, { statements: [{ sql }] });
      if (mutation === 'schema') db.exec('CREATE TABLE fictional_changed(n INTEGER)');
      if (mutation === 'method') db.function('fictional_added', () => 1);
      assert.throws(() =>
        withTerminalStatements(db, publication, () => terminalStatement(db, sql).get()),
      );
      assert.equal(calls, 0);
    } finally {
      db.close();
    }
  }
});
test('terminal iterators are scoped, drained and cleaned on thrown or deferred work', () => {
  const db = fixture();
  try {
    const sql = 'SELECT n FROM fictional_values';
    const prepare = () => prepareTerminalStatements(db, { statements: [{ sql }] });
    let iterator: IterableIterator<unknown> | undefined;
    assert.throws(
      () =>
        withTerminalStatements(db, prepare(), () => {
          iterator = terminalStatement(db, sql).iterate();
          return true;
        }),
      /unprepared/,
    );
    assert.throws(() => iterator!.next(), /expired/);
    withTerminalStatements(db, prepare(), () => {
      assert.deepEqual(
        [...terminalStatement(db, sql).iterate()].map((row) => row.n),
        [7],
      );
    });
    assert.throws(
      () => withTerminalStatements(db, prepare(), () => Promise.resolve(1)),
      /synchronous/,
    );
    assert.equal(db.prepare(sql).get()!.n, 7);
  } finally {
    db.close();
  }
});

test('foreign prepared statements cannot substitute for genuine connection authorization', () => {
  const db = fixture(),
    foreign = fixture();
  try {
    let calls = 0;
    foreign.function('fictional_foreign', () => {
      calls++;
      return 1;
    });
    db.setAuthorizer(() => constants.SQLITE_DENY);
    db.prepare = (sql) => foreign.prepare(sql);
    assert.throws(() =>
      prepareTerminalStatements(db, {
        statements: [{ sql: 'SELECT fictional_foreign() AS n' }],
      }),
    );
    assert.equal(calls, 0);
  } finally {
    db.close();
    foreign.close();
  }
});

test('throwing or returning after BEGIN rolls back within the callback-free scope', () => {
  const db = fixture();
  try {
    const prepare = () =>
      prepareTerminalStatements(db, {
        statements: [],
        executions: ['BEGIN IMMEDIATE', 'INSERT INTO fictional_values VALUES(19)'],
      });
    for (const throws of [true, false]) {
      assert.throws(() =>
        withTerminalStatements(db, prepare(), () => {
          terminalExecution(db, 'BEGIN IMMEDIATE');
          terminalExecution(db, 'INSERT INTO fictional_values VALUES(19)');
          if (throws) throw Error('fictional interruption');
          return true;
        }),
      );
      assert.equal(db.isTransaction, false);
      assert.deepEqual(
        db
          .prepare('SELECT n FROM fictional_values')
          .all()
          .map((row) => row.n),
        [7],
      );
    }
  } finally {
    db.close();
  }
});
