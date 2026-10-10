import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, StatementSync, constants } from 'node:sqlite';
import {
  installManagedDatabaseAuthorization,
  installManagedDatabaseFunctionRegistration,
  observeManagedDatabaseAuthorization,
} from '../database.ts';
import {
  prepareTerminalStatements,
  withTerminalStatements,
  terminalStatement,
  terminalExecution,
  replayTerminalRecordMutations,
  replayTerminalPreparedRecordIndex,
  type PreparedTerminalStatements,
} from '../database-terminal-statements.ts';
import {
  createRecordMutationRecipe,
  recordMutationStatement,
  recordMutationChangeset,
} from '../record-mutation-recipe.ts';
import { createRecordPreparedIndex } from '../record-prepared-index.ts';

function selectedChangeset() {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE fictional_selected(id INTEGER PRIMARY KEY,value TEXT)');
    const session = db.createSession({ table: 'fictional_selected' });
    try {
      db.prepare('INSERT INTO fictional_selected VALUES(?,?)').run(2, 'fictional accepted');
      return session.changeset();
    } finally {
      session.close();
    }
  } finally {
    db.close();
  }
}
function changesetFixture() {
  const db = fixture();
  db.exec(
    'CREATE TABLE fictional_selected(id INTEGER PRIMARY KEY,value TEXT); CREATE TABLE fictional_events(id INTEGER PRIMARY KEY,value TEXT); CREATE TRIGGER fictional_selected_event AFTER INSERT ON fictional_selected BEGIN INSERT INTO fictional_events(value) VALUES(new.value); END',
  );
  return db;
}

test('cached terminal DML enrolls only in capture and retains native resolution outside capture', async () => {
  const db = fixture(),
    recipe = createRecordMutationRecipe(db),
    sql = 'UPDATE fictional_values SET n=?',
    cached = db.prepare(sql);
  try {
    assert.equal(terminalStatement(db, sql, cached, false, 'changes'), cached);
    db.exec('BEGIN');
    recipe.capture(() => {
      assert.equal(terminalStatement(db, sql, cached, false, 'changes').run(23).changes, 1);
    });
    db.exec('ROLLBACK');
    const publication = prepareTerminalStatements(db, {
      recordMutationRecipe: recipe,
      statements: [...recipe.sql()].map((sql) => ({ sql })),
      executions: ['BEGIN IMMEDIATE', 'COMMIT'],
    });
    await recipe.prepareReplay();
    withTerminalStatements(db, publication, () => {
      terminalExecution(db, 'BEGIN IMMEDIATE');
      replayTerminalRecordMutations(db, recipe);
      terminalExecution(db, 'COMMIT');
    });
    assert.equal(db.prepare('SELECT n FROM fictional_values').get()!.n, 23);
  } finally {
    recipe.close();
    db.close();
  }
});

test('changeset recipe copies bytes, refreshes genuine policy and replays ordered native effects once', async () => {
  const db = changesetFixture(),
    recipe = createRecordMutationRecipe(db),
    changes = selectedChangeset(),
    index = createRecordPreparedIndex(db);
  let decisions = 0,
    policyCalls = 0,
    sealed = false;
  db.setAuthorizer((action, name) => {
    assert.equal(sealed, false, 'installed policy ran after final closure');
    if (action === constants.SQLITE_INSERT && name === 'fictional_selected') policyCalls++;
    return constants.SQLITE_OK;
  });
  try {
    db.exec('BEGIN');
    recipe.capture(() => {
      decisions++;
      recordMutationStatement(db, 'INSERT INTO fictional_selected VALUES(?,?)').run(1, 'first');
      assert.equal(recordMutationChangeset(db, changes), true);
      recordMutationStatement(db, 'UPDATE fictional_selected SET value=? WHERE id=?').run(
        'last',
        2,
      );
    });
    db.exec('ROLLBACK');
    changes.fill(0);
    assert.equal(recipe.writes(), 5n);
    assert.equal([...recipe.sql()].length, 2);
    await index.append('UPDATE fictional_values SET n=?', [41], 1);
    await index.appendCheck(
      'SELECT 1 FROM fictional_selected WHERE id=? AND value=?',
      [2, 'last'],
      true,
    );
    await index.seal();
    const publication = prepareTerminalStatements(db, {
      recordMutationRecipe: recipe,
      statements: [
        ...recipe.sql(),
        ...index.sql(),
        'SELECT id,value FROM fictional_selected ORDER BY id',
      ].map((sql) => ({ sql })),
      executions: ['BEGIN IMMEDIATE', 'COMMIT'],
    });
    const beforeRefresh = policyCalls;
    await recipe.prepareReplay();
    assert.ok(policyCalls > beforeRefresh);
    sealed = true;
    withTerminalStatements(db, publication, () => {
      assert.throws(() => recipe.close(), /expired or unprepared terminal/);
      terminalExecution(db, 'BEGIN IMMEDIATE');
      replayTerminalRecordMutations(db, recipe);
      assert.throws(() => replayTerminalRecordMutations(db, recipe), /consumed/);
      replayTerminalPreparedRecordIndex(db, index);
      const rows = terminalStatement(
        db,
        'SELECT id,value FROM fictional_selected ORDER BY id',
      ).iterate();
      assert.deepEqual({ ...rows.next().value }, { id: 1, value: 'first' });
      rows.return?.();
      assert.deepEqual(
        [
          ...terminalStatement(db, 'SELECT id,value FROM fictional_selected ORDER BY id').iterate(),
        ].map((row) => row.id),
        [1, 2],
      );
      terminalExecution(db, 'COMMIT');
    });
    sealed = false;
    assert.equal(decisions, 1);
    assert.equal(db.prepare('SELECT n FROM fictional_values').get()!.n, 41);
    assert.deepEqual(
      db
        .prepare('SELECT id,value FROM fictional_selected ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
      [
        { id: 1, value: 'first' },
        { id: 2, value: 'last' },
      ],
    );
    assert.deepEqual(
      db
        .prepare('SELECT value FROM fictional_events ORDER BY id')
        .all()
        .map((row) => row.value),
      ['first', 'fictional accepted'],
    );
  } finally {
    sealed = false;
    recipe.close();
    index.close();
    db.close();
  }
});

test('closing a refreshed recipe revokes its unused terminal inventory', async () => {
  const db = fixture(),
    recipe = createRecordMutationRecipe(db);
  try {
    db.exec('BEGIN');
    recipe.capture(() => recordMutationStatement(db, 'UPDATE fictional_values SET n=?').run(29));
    db.exec('ROLLBACK');
    const publication = prepareTerminalStatements(db, {
      recordMutationRecipe: recipe,
      statements: [...recipe.sql()].map((sql) => ({ sql })),
      executions: ['BEGIN IMMEDIATE', 'COMMIT'],
    });
    await recipe.prepareReplay();
    recipe.close();
    recipe.close();
    let entered = false;
    assert.throws(
      () =>
        withTerminalStatements(db, publication, () => {
          entered = true;
        }),
      /expired or unprepared terminal/,
    );
    assert.equal(entered, false);
    assert.equal(db.isTransaction, false);
    assert.equal(db.prepare('SELECT n FROM fictional_values').get()!.n, 7);
  } finally {
    recipe.close();
    db.close();
  }
});

test('a failure after native changeset replay preserves its cause and rolls back with refreshed bytecode', async () => {
  const db = changesetFixture(),
    recipe = createRecordMutationRecipe(db);
  let sealed = false;
  db.setAuthorizer(() => {
    assert.equal(sealed, false, 'rollback entered installed policy after final closure');
    return constants.SQLITE_OK;
  });
  try {
    db.exec('BEGIN');
    recipe.capture(() => {
      recordMutationChangeset(db, selectedChangeset());
      recordMutationStatement(db, 'UPDATE fictional_values SET n=?').run(43);
    });
    db.exec('ROLLBACK');
    const publication = prepareTerminalStatements(db, {
      recordMutationRecipe: recipe,
      statements: [...recipe.sql()].map((sql) => ({ sql })),
      executions: ['BEGIN IMMEDIATE', 'COMMIT'],
    });
    await recipe.prepareReplay();
    sealed = true;
    const failure = Error('fictional failure after replay');
    assert.throws(
      () =>
        withTerminalStatements(db, publication, () => {
          terminalExecution(db, 'BEGIN IMMEDIATE');
          replayTerminalRecordMutations(db, recipe);
          throw failure;
        }),
      (error) => error === failure,
    );
    assert.equal(db.isTransaction, false);
    sealed = false;
    assert.equal(db.prepare('SELECT count(*) AS n FROM fictional_selected').get()!.n, 0);
    assert.equal(db.prepare('SELECT n FROM fictional_values').get()!.n, 7);
  } finally {
    sealed = false;
    recipe.close();
    db.close();
  }
});

test('every terminal literal refreshes current policy before the final physical closure', async () => {
  const db = fixture(),
    recipe = createRecordMutationRecipe(db),
    sql = 'UPDATE fictional_values SET n=?';
  let deny = false;
  db.setAuthorizer((action, name) =>
    deny && action === constants.SQLITE_UPDATE && name === 'fictional_values'
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  try {
    db.exec('BEGIN');
    recipe.capture(() => recordMutationStatement(db, sql).run(47));
    db.exec('ROLLBACK');
    prepareTerminalStatements(db, {
      recordMutationRecipe: recipe,
      statements: [{ sql }],
      executions: ['BEGIN IMMEDIATE', 'COMMIT'],
    });
    deny = true;
    await assert.rejects(recipe.prepareReplay(), /authoriz/);
    assert.equal(db.prepare('SELECT n FROM fictional_values').get()!.n, 7);
  } finally {
    recipe.close();
    db.close();
  }
});

test('changeset policy closure changes refuse fresh preparation without a setter change', async () => {
  const db = changesetFixture(),
    recipe = createRecordMutationRecipe(db);
  let refuse = false;
  db.setAuthorizer((action, name) =>
    refuse && action === constants.SQLITE_INSERT && name === 'fictional_selected'
      ? constants.SQLITE_DENY
      : constants.SQLITE_OK,
  );
  try {
    db.exec('BEGIN');
    recipe.capture(() => recordMutationChangeset(db, selectedChangeset()));
    db.exec('ROLLBACK');
    refuse = true;
    await assert.rejects(recipe.prepareReplay(), /changeset invocation/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM fictional_selected').get()!.n, 0);
  } finally {
    recipe.close();
    db.close();
  }
});

test('changeset capture refuses cached raw writes from an authorizer callback', () => {
  const db = changesetFixture(),
    recipe = createRecordMutationRecipe(db),
    raw = db.prepare('INSERT INTO fictional_values VALUES(31)');
  db.setAuthorizer((action, name) => {
    if (action === constants.SQLITE_INSERT && name === 'fictional_selected') raw.run();
    return constants.SQLITE_OK;
  });
  try {
    db.exec('BEGIN');
    assert.throws(() => recipe.capture(() => recordMutationChangeset(db, selectedChangeset())));
    db.exec('ROLLBACK');
    assert.throws(() => [...recipe.sql()], /recipe changed/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM fictional_selected').get()!.n, 0);
  } finally {
    recipe.close();
    db.close();
  }
});

test('changeset witnesses refuse a changed observer roster even without a method epoch change', async () => {
  const db = changesetFixture(),
    recipe = createRecordMutationRecipe(db);
  let stop: (() => void) | undefined;
  try {
    db.exec('BEGIN');
    recipe.capture(() => recordMutationChangeset(db, selectedChangeset()));
    db.exec('ROLLBACK');
    stop = observeManagedDatabaseAuthorization(
      db,
      () => {},
      () => {},
    );
    await assert.rejects(recipe.prepareReplay(), /changeset invocation/);
  } finally {
    stop?.();
    recipe.close();
    db.close();
  }
});

test('changeset policy preflight cannot enroll nested SQL even when its error is caught', async () => {
  const db = changesetFixture(),
    recipe = createRecordMutationRecipe(db);
  let nested = false;
  db.setAuthorizer((action, name) => {
    if (nested && action === constants.SQLITE_INSERT && name === 'fictional_selected')
      assert.throws(() => db.prepare('SELECT 1').get(), /authorization|changeset invocation/);
    return constants.SQLITE_OK;
  });
  try {
    db.exec('BEGIN');
    recipe.capture(() => recordMutationChangeset(db, selectedChangeset()));
    db.exec('ROLLBACK');
    nested = true;
    await assert.rejects(recipe.prepareReplay(), /changeset invocation/);
    assert.equal(db.prepare('SELECT count(*) AS n FROM fictional_selected').get()!.n, 0);
  } finally {
    recipe.close();
    db.close();
  }
});

function fixture() {
  const db = new DatabaseSync(':memory:');
  installManagedDatabaseFunctionRegistration(db);
  installManagedDatabaseAuthorization(db);
  db.exec('CREATE TABLE fictional_values(n INTEGER); INSERT INTO fictional_values VALUES(7)');
  return db;
}
test('terminal recipe resolver admits only genuine exact-connection recipes', async () => {
  const db = fixture(),
    foreign = fixture(),
    recipe = createRecordMutationRecipe(db),
    other = createRecordMutationRecipe(foreign),
    sql = 'UPDATE fictional_values SET n=?';
  try {
    db.exec('BEGIN');
    recipe.capture(() => recordMutationStatement(db, sql).run(11));
    db.exec('ROLLBACK');
    foreign.exec('BEGIN');
    other.capture(() => recordMutationStatement(foreign, sql).run(13));
    foreign.exec('ROLLBACK');
    const publication = prepareTerminalStatements(db, {
      statements: [{ sql }],
      executions: ['BEGIN IMMEDIATE', 'COMMIT'],
    });
    await recipe.prepareReplay();
    let calls = 0;
    const forged = Object.defineProperty({}, 'replay', {
      get() {
        calls++;
        return recipe.replay;
      },
    });
    withTerminalStatements(db, publication, () => {
      terminalExecution(db, 'BEGIN IMMEDIATE');
      assert.throws(() => replayTerminalRecordMutations(db, forged as typeof recipe), /terminal/);
      assert.throws(() => replayTerminalRecordMutations(db, other), /terminal/);
      assert.equal(calls, 0);
      replayTerminalRecordMutations(db, recipe);
      assert.throws(() => replayTerminalRecordMutations(db, recipe), /recipe/);
      terminalExecution(db, 'COMMIT');
    });
    assert.equal(db.prepare('SELECT n FROM fictional_values').get()!.n, 11);
    assert.equal(foreign.prepare('SELECT n FROM fictional_values').get()!.n, 7);
    assert.throws(() => replayTerminalRecordMutations(db, recipe), /terminal/);
  } finally {
    recipe.close();
    other.close();
    db.close();
    foreign.close();
  }
});
test('sealed terminal recipe never invokes mutable scratch statement methods', async () => {
  const db = fixture(),
    recipe = createRecordMutationRecipe(db),
    sql = 'UPDATE fictional_values SET n=?',
    names = ['get', 'all', 'run', 'iterate'] as const,
    originals = names.map((name) =>
      Object.getOwnPropertyDescriptor(StatementSync.prototype, name)!,
    );
  let calls = 0;
  try {
    db.exec('BEGIN');
    recipe.capture(() => recordMutationStatement(db, sql).run(17));
    db.exec('ROLLBACK');
    const publication = prepareTerminalStatements(db, {
      statements: [{ sql }],
      executions: ['BEGIN IMMEDIATE', 'COMMIT'],
    });
    await recipe.prepareReplay();
    for (let index = 0; index < names.length; index++)
      Object.defineProperty(StatementSync.prototype, names[index]!, {
        configurable: true,
        get() {
          calls++;
          return originals[index]!.value;
        },
      });
    withTerminalStatements(db, publication, () => {
      terminalExecution(db, 'BEGIN IMMEDIATE');
      replayTerminalRecordMutations(db, recipe);
      terminalExecution(db, 'COMMIT');
    });
    assert.equal(calls, 0);
  } finally {
    for (let index = 0; index < names.length; index++)
      Object.defineProperty(StatementSync.prototype, names[index]!, originals[index]!);
    recipe.close();
    assert.equal(db.prepare('SELECT n FROM fictional_values').get()!.n, 17);
    db.close();
  }
});
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
