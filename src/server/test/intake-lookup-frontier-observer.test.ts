import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync, constants } from 'node:sqlite';
import {
  installManagedDatabaseAuthorization,
  installManagedDatabaseFunctionRegistration,
  currentTransactionToken,
  transaction,
  observeManagedDatabaseAuthorization,
  rearmManagedDatabaseAuthorization,
} from '../database.ts';
import {
  applyObservedClinicalProjectionChangeset,
  beginIntakeFrontierAuxiliaryPreparation,
  blockIntakeFrontierReadmission,
  captureIntakeFrontierAttempts,
  ensureIntakeFrontierObserver,
  execIntakeFrontierAuxiliarySQL,
  expectIntakeFrontierCurationRevisionWrite,
  expectIntakeFrontierMetaWrite,
  expectIntakeFrontierSourceWrite,
  expectIntakeFrontierStateWrite,
  finishIntakeFrontierAuxiliaryPreparation,
  finishIntakeFrontierCurationRevisionWrite,
  prepareIntakeFrontierAuxiliaryInsert,
  finishIntakeFrontierMetaWrite,
  finishIntakeFrontierSourceWrite,
  intakeFrontierAttemptCounts,
  readIntakeFrontierActiveUnwritten,
  readIntakeFrontierAttempts,
  readIntakeFrontierAcceptedTransition,
  readIntakeFrontierCommittedChain,
  readIntakeFrontierOwnedLookupDirtyWrite,
  readIntakeFrontierSourceOutcomeCandidates,
  readIntakeFrontierSourceEquality,
  runIntakeFrontierAuxiliaryInsert,
  protectedIntakeLookupTempShadow,
  protectedIntakeLookupTempShadowSql,
} from '../intake-lookup-frontier-observer.ts';
import {
  prepareTerminalStatements,
  withTerminalStatements,
} from '../database-terminal-statements.ts';

function shadowFixture(t: TestContext) {
  const db = new DatabaseSync(':memory:');
  installManagedDatabaseAuthorization(db);
  installManagedDatabaseFunctionRegistration(db);
  t.after(() => {
    if (db.isOpen) db.close();
  });
  return db;
}

test('protected TEMP shadow checks reuse preparation, never scan results or method epochs', (t) => {
  const db = shadowFixture(t),
    nativeGet = StatementSync.prototype.get,
    statements = new Set<StatementSync>();
  let scans = 0,
    compilations = 0;
  db.setAuthorizer((action) => {
    if (action === constants.SQLITE_SELECT) compilations++;
    return constants.SQLITE_OK;
  });
  StatementSync.prototype.get = function (...args) {
    if (this.sourceSQL === protectedIntakeLookupTempShadowSql) {
      scans++;
      statements.add(this);
    }
    return Reflect.apply(nativeGet, this, args);
  };
  try {
    for (let index = 0; index < 6; index++)
      assert.equal(protectedIntakeLookupTempShadow(db), false);
    assert.equal(scans, 6);
    assert.equal(compilations, 1);
    assert.equal(statements.size, 1);
    db.function('fictional_shadow_epoch', () => 1);
    assert.equal(protectedIntakeLookupTempShadow(db), false);
    assert.equal(statements.size, 2, 'function epoch gets freshly prepared bytecode');
    db.setAuthorizer(null);
    assert.equal(protectedIntakeLookupTempShadow(db), false);
    assert.equal(statements.size, 3, 'policy epoch gets freshly prepared bytecode');
    db.exec('CREATE TEMP VIEW APP_META AS SELECT 1 AS value');
    assert.equal(protectedIntakeLookupTempShadow(db), true);
    db.exec('DROP VIEW temp.APP_META');
    assert.equal(protectedIntakeLookupTempShadow(db), false);
    db.exec('CREATE TEMP TABLE __RECORD_INTAKE_LOOKUP_FICTIONAL(value TEXT)');
    assert.equal(protectedIntakeLookupTempShadow(db), true);
    const foreign = shadowFixture(t);
    assert.equal(protectedIntakeLookupTempShadow(foreign), false);
    db.close();
    assert.throws(() => protectedIntakeLookupTempShadow(db));
  } finally {
    StatementSync.prototype.get = nativeGet;
  }
});

test('protected TEMP shadow checks preserve custom preparation and changed deny policies', (t) => {
  const db = shadowFixture(t),
    prepare = db.prepare;
  assert.equal(protectedIntakeLookupTempShadow(db), false);
  let preparations = 0;
  db.prepare = function (sql) {
    preparations++;
    return prepare.call(this, sql);
  };
  try {
    assert.equal(protectedIntakeLookupTempShadow(db), false);
    assert.equal(protectedIntakeLookupTempShadow(db), false);
    assert.equal(preparations, 2);
  } finally {
    db.prepare = prepare;
  }
  db.setAuthorizer((action) =>
    action === constants.SQLITE_SELECT ? constants.SQLITE_DENY : constants.SQLITE_OK,
  );
  assert.throws(() => protectedIntakeLookupTempShadow(db));
  db.setAuthorizer(null);
  assert.equal(protectedIntakeLookupTempShadow(db), false);
});

test('protected TEMP shadow reentry uses a separate statement during native reprepare', (t) => {
  const db = shadowFixture(t);
  let armed = false,
    nested: boolean | undefined;
  db.setAuthorizer((action) => {
    if (armed && action === constants.SQLITE_SELECT) {
      armed = false;
      nested = protectedIntakeLookupTempShadow(db);
    }
    return constants.SQLITE_OK;
  });
  assert.equal(protectedIntakeLookupTempShadow(db), false);
  db.exec('CREATE TEMP TABLE fictional_unrelated_shadow(value TEXT)');
  armed = true;
  assert.equal(protectedIntakeLookupTempShadow(db), false);
  assert.equal(armed, false, 'schema change exercised the real reprepare callback');
  assert.equal(nested, false);
});

test('protected TEMP shadow bytecode reauthorizes new observers and managed rearming', (t) => {
  const db = shadowFixture(t);
  assert.equal(protectedIntakeLookupTempShadow(db), false);
  let observed = 0;
  const dispose = observeManagedDatabaseAuthorization(
    db,
    (action) => {
      if (action === constants.SQLITE_SELECT) observed++;
    },
    () => {},
  );
  assert.ok(dispose);
  try {
    assert.equal(protectedIntakeLookupTempShadow(db), false);
    assert.equal(observed, 1, 'new observer sees the cached query recompile');
    assert.equal(protectedIntakeLookupTempShadow(db), false);
    assert.equal(observed, 1, 'unchanged bytecode needs no further compilation');
    assert.equal(rearmManagedDatabaseAuthorization(db), true);
    assert.equal(protectedIntakeLookupTempShadow(db), false);
    assert.equal(observed, 2, 'rearming reauthorizes the cached query again');
  } finally {
    dispose();
  }
});

test('protected TEMP shadow caches cannot escape the active terminal inventory', (t) => {
  const db = shadowFixture(t);
  assert.equal(protectedIntakeLookupTempShadow(db), false);
  const missing = prepareTerminalStatements(db, { statements: [] });
  withTerminalStatements(db, missing, () => {
    assert.throws(() => protectedIntakeLookupTempShadow(db), /unprepared terminal/);
  });
  const included = prepareTerminalStatements(db, {
    statements: [{ sql: protectedIntakeLookupTempShadowSql }],
  });
  withTerminalStatements(db, included, () => {
    assert.equal(protectedIntakeLookupTempShadow(db), false);
  });
});

function clinicalChangeset(): Uint8Array {
  const staged = new DatabaseSync(':memory:');
  try {
    staged.exec('CREATE TABLE source_records(id TEXT PRIMARY KEY,source_file_id TEXT)');
    const session = staged.createSession();
    try {
      staged.prepare('INSERT INTO source_records VALUES(?,?)').run('fictional-record', 'selected');
      return session.changeset();
    } finally {
      session.close();
    }
  } finally {
    staged.close();
  }
}

test('one exact source insert remains a candidate under its original frontier', (t) => {
  const f = fixture(t);
  transaction(
    f.db,
    () => {
      const expected = expectIntakeFrontierSourceWrite(f.db, 'new', 'insert');
      let written = false;
      try {
        written =
          f.db.prepare("INSERT INTO source_files VALUES('new','intake_original')").run().changes ===
          1;
      } finally {
        finishIntakeFrontierSourceWrite(f.db, expected, written);
      }
    },
    { actor: 'source-text' },
  );
  const interval = readIntakeFrontierAttempts(f.db, f.captured!);
  assert.ok(interval);
  assert.equal(interval.attempts, 2);
  assert.equal(interval.ownedWrites, 2);
  assert.deepEqual(interval.headSourceIds, ['new']);
  assert.equal(interval.ordinaryTokens.length, 1);
  assert.deepEqual(
    readIntakeFrontierSourceOutcomeCandidates(f.db, f.captured!)?.map((item) => item.sourceIds),
    [['new']],
  );
});

test('V4 immutable staging cannot credit a triggered extra app_meta write', (t) => {
  for (const extra of [false, true]) {
    const f = fixture(
      t,
      extra
        ? (db) =>
            db.exec(`CREATE TEMP TRIGGER extra_v4_stage AFTER INSERT ON main.app_meta
              WHEN NEW.key='intake_state_v1:fictional:node'
              BEGIN INSERT INTO app_meta(key,value) VALUES('fictional-extra-stage','extra'); END`)
        : undefined,
    );
    transaction(
      f.db,
      () => {
        const key = 'intake_state_v1:fictional:node';
        const expected = expectIntakeFrontierMetaWrite(f.db, key, ['insert']);
        let written = false;
        try {
          written =
            f.db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(key, '{}').changes ===
            1;
        } finally {
          finishIntakeFrontierMetaWrite(f.db, expected, written);
        }
      },
      { actor: 'intake-state' },
    );
    if (extra) {
      assert.equal(readIntakeFrontierAttempts(f.db, f.captured!), undefined);
      assert.equal(intakeFrontierAttemptCounts(f.db)?.revoked, true);
    } else {
      const interval = readIntakeFrontierAttempts(f.db, f.captured!);
      assert.ok(interval);
      assert.equal(interval.attempts, 3);
      assert.equal(interval.ownedWrites, 3);
    }
  }
});

test('source insert credits only keyed accepted-capture and text-dirty trigger rows', (t) => {
  for (const preexisting of [false, true]) {
    const f = fixture(t, (db) => {
      db.exec(`CREATE TEMP TABLE __record_changed(entity TEXT,record_id TEXT,PRIMARY KEY(entity,record_id));
        CREATE TEMP TABLE __source_text_dirty(source_id TEXT PRIMARY KEY);
        CREATE TEMP TABLE unrelated_source_side_effect(value TEXT);
        CREATE TEMP TRIGGER __record_capture_source_files_INSERT AFTER INSERT ON main.source_files BEGIN
          INSERT INTO __record_changed SELECT 'source_files',json_array(NEW.id)
          WHERE NOT EXISTS(SELECT 1 FROM __record_changed WHERE entity='source_files' AND record_id=json_array(NEW.id));
        END;
        CREATE TEMP TRIGGER __source_text_insert AFTER INSERT ON main.source_files BEGIN
          INSERT INTO __source_text_dirty SELECT NEW.id
          WHERE NOT EXISTS(SELECT 1 FROM __source_text_dirty WHERE source_id=NEW.id);
        END;`);
      if (preexisting)
        db.exec(`INSERT INTO temp.__record_changed VALUES('source_files',json_array('new'));
          INSERT INTO temp.__source_text_dirty VALUES('new')`);
    });
    transaction(
      f.db,
      () => {
        const expected = expectIntakeFrontierSourceWrite(f.db, 'new', 'insert');
        let written = false;
        try {
          written =
            f.db.prepare("INSERT INTO source_files VALUES('new','intake_original')").run()
              .changes === 1;
        } finally {
          finishIntakeFrontierSourceWrite(f.db, expected, written);
        }
      },
      { actor: 'source-text' },
    );
    assert.deepEqual(
      readIntakeFrontierAttempts(f.db, f.captured!)?.headSourceIds,
      ['new'],
      JSON.stringify({ preexisting, state: intakeFrontierAttemptCounts(f.db) }),
    );
  }
});

test('source trigger row witnesses never credit an unrelated extra write', (t) => {
  const f = fixture(t, (db) => {
    db.exec(`CREATE TEMP TABLE __record_changed(entity TEXT,record_id TEXT,PRIMARY KEY(entity,record_id));
      CREATE TEMP TABLE __source_text_dirty(source_id TEXT PRIMARY KEY);
      CREATE TEMP TABLE unrelated_source_side_effect(value TEXT);
      CREATE TEMP TRIGGER __record_capture_source_files_INSERT AFTER INSERT ON main.source_files BEGIN
        INSERT INTO __record_changed SELECT 'source_files',json_array(NEW.id)
        WHERE NOT EXISTS(SELECT 1 FROM __record_changed WHERE entity='source_files' AND record_id=json_array(NEW.id));
      END;
      CREATE TEMP TRIGGER __source_text_insert AFTER INSERT ON main.source_files BEGIN
        INSERT INTO __source_text_dirty SELECT NEW.id
        WHERE NOT EXISTS(SELECT 1 FROM __source_text_dirty WHERE source_id=NEW.id);
      END;`);
  });
  transaction(
    f.db,
    () => {
      const expected = expectIntakeFrontierSourceWrite(f.db, 'new', 'insert');
      let written = false;
      try {
        written =
          f.db.prepare("INSERT INTO source_files VALUES('new','intake_original')").run().changes ===
          1;
        f.db.prepare("INSERT INTO temp.unrelated_source_side_effect VALUES('fictional')").run();
      } finally {
        finishIntakeFrontierSourceWrite(f.db, expected, written);
      }
    },
    { actor: 'source-text' },
  );
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured!), undefined);
});

test('candidate source IDs stay attached to their own committed outcome', (t) => {
  const f = fixture(t);
  for (const id of ['first', 'second'])
    transaction(
      f.db,
      () => {
        const expected = expectIntakeFrontierSourceWrite(f.db, id, 'insert');
        let written = false;
        try {
          written =
            f.db.prepare('INSERT INTO source_files VALUES(?,?)').run(id, 'intake_original')
              .changes === 1;
        } finally {
          finishIntakeFrontierSourceWrite(f.db, expected, written);
        }
      },
      { actor: 'source-text' },
    );
  const candidates = readIntakeFrontierSourceOutcomeCandidates(f.db, f.captured!);
  assert.deepEqual(
    candidates?.map((item) => item.sourceIds),
    [['first'], ['second']],
  );
  assert.notEqual(candidates?.[0]?.token, candidates?.[1]?.token);
  assert.deepEqual(
    candidates?.map((item) => item.token),
    readIntakeFrontierAttempts(f.db, f.captured!)?.ordinaryTokens,
  );
  assert.equal(readIntakeFrontierAcceptedTransition(f.db, f.captured!), undefined);
});

function insertSource(db: DatabaseSync, id: string, kind = 'intake_original') {
  transaction(
    db,
    () => {
      const expected = expectIntakeFrontierSourceWrite(db, id, 'insert', kind);
      let written = false;
      try {
        written = db.prepare('INSERT INTO source_files VALUES(?,?)').run(id, kind).changes === 1;
      } finally {
        finishIntakeFrontierSourceWrite(db, expected, written);
      }
    },
    { actor: 'source-text' },
  );
}

test('committed chain links every writing outcome in order with its own source IDs', (t) => {
  const f = fixture(t);
  insertSource(f.db, 'first');
  insertSource(f.db, 'proposal-new', 'intake_proposal');
  insertSource(f.db, 'second');
  const chain = readIntakeFrontierCommittedChain(f.db, f.captured!);
  assert.ok(chain);
  assert.deepEqual(
    chain.outcomes.map((outcome) => [outcome.maintenance, outcome.sourceIds]),
    [
      [false, ['first']],
      [false, ['proposal-new']],
      [false, ['second']],
    ],
  );
  // Only originals are head sources; the proposal insert is credited, not a head.
  assert.deepEqual(chain.headSourceIds, ['first', 'second']);
  assert.deepEqual(
    chain.outcomes.map((outcome) => outcome.token),
    readIntakeFrontierSourceOutcomeCandidates(f.db, f.captured!)?.map((item) => item.token),
  );
  // A later snapshot links only its own suffix.
  const later = captureIntakeFrontierAttempts(f.db);
  assert.ok(later);
  insertSource(f.db, 'third');
  assert.deepEqual(
    readIntakeFrontierCommittedChain(f.db, later)?.outcomes.map((outcome) => outcome.sourceIds),
    [['third']],
  );
});

test('committed chain refuses an unattributed autocommit write between outcomes', (t) => {
  const f = fixture(t, (db) => db.exec('CREATE TABLE unrelated(value TEXT)'));
  insertSource(f.db, 'first');
  assert.ok(readIntakeFrontierCommittedChain(f.db, f.captured!));
  f.db.prepare("INSERT INTO unrelated VALUES('fictional')").run();
  assert.equal(readIntakeFrontierCommittedChain(f.db, f.captured!), undefined);
  insertSource(f.db, 'second');
  assert.equal(readIntakeFrontierCommittedChain(f.db, f.captured!), undefined);
});

test('committed chain refuses a snapshot older than its bounded outcome window', (t) => {
  const f = fixture(t);
  const insert = f.db.prepare('INSERT INTO source_records VALUES(?,?)');
  let recent = f.captured!;
  for (let index = 0; index < 101; index++) {
    if (index === 1) {
      const next = captureIntakeFrontierAttempts(f.db);
      assert.ok(next);
      recent = next;
    }
    transaction(f.db, () => insert.run(`chain-record-${index}`, 'selected'), {
      actor: 'source-text',
    });
  }
  assert.equal(readIntakeFrontierCommittedChain(f.db, f.captured!), undefined);
  assert.equal(readIntakeFrontierCommittedChain(f.db, recent)?.outcomes.length, 100);
});

test('a source insert of another kind is credited only for its declared kind', (t) => {
  const exact = fixture(t);
  insertSource(exact.db, 'proposal-new', 'intake_proposal');
  const interval = readIntakeFrontierAttempts(exact.db, exact.captured!);
  assert.ok(interval);
  assert.deepEqual(interval.headSourceIds, []);
  assert.equal(interval.ordinaryTokens.length, 1);

  const mismatched = fixture(t);
  transaction(
    mismatched.db,
    () => {
      const expected = expectIntakeFrontierSourceWrite(
        mismatched.db,
        'declared-proposal',
        'insert',
        'intake_proposal',
      );
      let written = false;
      try {
        written =
          mismatched.db
            .prepare("INSERT INTO source_files VALUES('declared-proposal','intake_original')")
            .run().changes === 1;
      } finally {
        finishIntakeFrontierSourceWrite(mismatched.db, expected, written);
      }
    },
    { actor: 'source-text' },
  );
  assert.equal(readIntakeFrontierAttempts(mismatched.db, mismatched.captured!), undefined);
  assert.equal(readIntakeFrontierCommittedChain(mismatched.db, mismatched.captured!), undefined);
});

test('an active transaction reads the original frontier only until its first write', (t) => {
  const f = fixture(t);
  const seen: boolean[] = [];
  transaction(
    f.db,
    () => {
      seen.push(readIntakeFrontierActiveUnwritten(f.db, f.captured!));
      f.ownerWrite();
      seen.push(readIntakeFrontierActiveUnwritten(f.db, f.captured!));
    },
    { actor: 'source-text' },
  );
  assert.deepEqual(seen, [true, false]);
  assert.equal(readIntakeFrontierActiveUnwritten(f.db, f.captured!), false);
});

test('source-row bracket never excuses a second or rekeyed write', (t) => {
  const extra = fixture(t);
  transaction(
    extra.db,
    () => {
      const expected = expectIntakeFrontierSourceWrite(extra.db, 'new', 'insert');
      extra.db.prepare("INSERT INTO source_files VALUES('new','intake_original')").run();
      extra.db.prepare("INSERT INTO source_files VALUES('another','intake_original')").run();
      finishIntakeFrontierSourceWrite(extra.db, expected, true);
    },
    { actor: 'source-text' },
  );
  assert.equal(readIntakeFrontierAttempts(extra.db, extra.captured!), undefined);

  const rekey = fixture(t);
  transaction(
    rekey.db,
    () => {
      const expected = expectIntakeFrontierSourceWrite(rekey.db, 'selected', 'update');
      const written =
        rekey.db.prepare("UPDATE source_files SET id='renamed' WHERE id='selected'").run()
          .changes === 1;
      finishIntakeFrontierSourceWrite(rekey.db, expected, written);
    },
    { actor: 'source-text' },
  );
  assert.equal(readIntakeFrontierAttempts(rekey.db, rekey.captured!), undefined);

  const reordered = fixture(t);
  transaction(
    reordered.db,
    () => {
      const expected = expectIntakeFrontierSourceWrite(reordered.db, 'early', 'insert');
      const written =
        reordered.db
          .prepare("INSERT INTO source_files(rowid,id,kind) VALUES(0,'early','intake_original')")
          .run().changes === 1;
      finishIntakeFrontierSourceWrite(reordered.db, expected, written);
    },
    { actor: 'source-text' },
  );
  assert.equal(readIntakeFrontierAttempts(reordered.db, reordered.captured!), undefined);
});

test('source-row bracket credits only its exact clinical pin side effect', (t) => {
  const f = fixture(t);
  transaction(
    f.db,
    () => {
      const expected = expectIntakeFrontierSourceWrite(f.db, 'new', 'insert');
      const written =
        f.db.prepare("INSERT INTO source_files VALUES('new','intake_original')").run().changes ===
        1;
      f.db.exec('UPDATE temp.__intake_clinical_cache_pin SET value=value+1 WHERE id=1');
      finishIntakeFrontierSourceWrite(f.db, expected, written);
    },
    { actor: 'source-text' },
  );
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured!), undefined);
});

test('source details update carries no clinical pin credit', (t) => {
  const f = fixture(t, (db) => {
    for (const column of [
      'provider_id TEXT',
      'path TEXT',
      'sha256 TEXT',
      'bytes INTEGER',
      'details_json TEXT',
    ])
      db.exec(`ALTER TABLE source_files ADD COLUMN ${column}`);
  });
  transaction(
    f.db,
    () => {
      const expected = expectIntakeFrontierSourceWrite(f.db, 'selected', 'update');
      const written =
        f.db
          .prepare("UPDATE source_files SET details_json='fictional updated' WHERE id='selected'")
          .run().changes === 1;
      finishIntakeFrontierSourceWrite(f.db, expected, written);
    },
    { actor: 'source-text' },
  );
  const interval = readIntakeFrontierAttempts(f.db, f.captured!);
  assert.ok(interval);
  assert.equal(interval.attempts, interval.ownedWrites);
  assert.deepEqual(interval.headSourceIds, ['selected']);
});

test('source-row bracket credits only its keyed installed lookup-dirty trigger', (t) => {
  const install = (db: DatabaseSync) =>
    db.exec(`CREATE TEMP TABLE __intake_lookup_dirty(source_id TEXT PRIMARY KEY);
      CREATE TEMP TABLE unrelated_source_work(value TEXT);
      CREATE TEMP TRIGGER __intake_lookup_insert AFTER INSERT ON main.source_files BEGIN
        INSERT INTO __intake_lookup_dirty(source_id)
        SELECT NEW.id WHERE NOT EXISTS (
          SELECT 1 FROM __intake_lookup_dirty WHERE source_id=NEW.id
        );
      END;`);
  const exact = fixture(t, install);
  transaction(
    exact.db,
    () => {
      const expected = expectIntakeFrontierSourceWrite(exact.db, 'new', 'insert');
      const written =
        exact.db.prepare("INSERT INTO source_files VALUES('new','intake_original')").run()
          .changes === 1;
      finishIntakeFrontierSourceWrite(exact.db, expected, written);
    },
    { actor: 'source-text' },
  );
  const interval = readIntakeFrontierAttempts(exact.db, exact.captured!);
  assert.ok(interval);
  assert.equal(interval.attempts, interval.ownedWrites);
  assert.deepEqual(interval.headSourceIds, ['new']);
  assert.equal(
    exact.db
      .prepare("SELECT COUNT(*) AS n FROM temp.__intake_lookup_dirty WHERE source_id='new'")
      .get()?.n,
    1,
  );

  const extra = fixture(t, install);
  transaction(
    extra.db,
    () => {
      const expected = expectIntakeFrontierSourceWrite(extra.db, 'new', 'insert');
      const written =
        extra.db.prepare("INSERT INTO source_files VALUES('new','intake_original')").run()
          .changes === 1;
      extra.db.prepare("INSERT INTO temp.unrelated_source_work VALUES('extra')").run();
      finishIntakeFrontierSourceWrite(extra.db, expected, written);
    },
    { actor: 'source-text' },
  );
  assert.equal(readIntakeFrontierAttempts(extra.db, extra.captured!), undefined);
});

test('rolled-back and callback-reentered source writes cannot reuse the old frontier', (t) => {
  const rollback = fixture(t);
  assert.throws(
    () =>
      transaction(
        rollback.db,
        () => {
          const expected = expectIntakeFrontierSourceWrite(rollback.db, 'rolled-back', 'insert');
          const written =
            rollback.db
              .prepare("INSERT INTO source_files VALUES('rolled-back','intake_original')")
              .run().changes === 1;
          finishIntakeFrontierSourceWrite(rollback.db, expected, written);
          throw Error('fictional rollback');
        },
        { actor: 'source-text' },
      ),
    /fictional rollback/,
  );
  assert.equal(readIntakeFrontierAttempts(rollback.db, rollback.captured!), undefined);
  ensureIntakeFrontierObserver(rollback.db);
  const fresh = captureIntakeFrontierAttempts(rollback.db);
  assert.ok(fresh);
  assert.equal(readIntakeFrontierAttempts(rollback.db, rollback.captured!), undefined);

  let reenter: (() => void) | undefined;
  const nested = fixture(t, (db) =>
    db.function('source_write_reentry', () => {
      reenter?.();
      return null;
    }),
  );
  reenter = () => {
    expectIntakeFrontierSourceWrite(nested.db, 'another', 'insert');
  };
  transaction(
    nested.db,
    () => {
      const expected = expectIntakeFrontierSourceWrite(nested.db, 'new', 'insert');
      nested.db.prepare('SELECT source_write_reentry()').get();
      const written =
        nested.db.prepare("INSERT INTO source_files VALUES('new','intake_original')").run()
          .changes === 1;
      finishIntakeFrontierSourceWrite(nested.db, expected, written);
    },
    { actor: 'source-text' },
  );
  assert.equal(readIntakeFrontierAttempts(nested.db, nested.captured!), undefined);
});

test('fixed curation revision autocommit cannot absorb unrelated writes', (t) => {
  const exact = fixture(t);
  const expected = expectIntakeFrontierCurationRevisionWrite(exact.db, '1');
  const written =
    exact.db
      .prepare(
        "INSERT INTO app_meta(key,value) VALUES('curation_revision','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run().changes === 1;
  finishIntakeFrontierCurationRevisionWrite(exact.db, expected, written);
  const interval = readIntakeFrontierAttempts(exact.db, exact.captured!);
  assert.ok(interval);
  assert.equal(interval.attempts, 1);
  assert.equal(interval.ownedWrites, 1);
  assert.equal(interval.ordinaryTokens.length, 0);

  const extra = fixture(t, (db) => db.exec('CREATE TABLE unrelated(value TEXT)'));
  extra.db.prepare("INSERT INTO unrelated VALUES('fictional')").run();
  const afterUnknown = expectIntakeFrontierCurationRevisionWrite(extra.db, '1');
  const updated =
    extra.db
      .prepare(
        "INSERT INTO app_meta(key,value) VALUES('curation_revision','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run().changes === 1;
  finishIntakeFrontierCurationRevisionWrite(extra.db, afterUnknown, updated);
  assert.equal(readIntakeFrontierAttempts(extra.db, extra.captured!), undefined);
});

function fixture(t: TestContext, beforeObserver?: (db: DatabaseSync) => void) {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE source_files(id TEXT PRIMARY KEY,kind TEXT);
    CREATE TABLE source_records(id TEXT PRIMARY KEY,source_file_id TEXT);
    CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE __record_state(singleton INTEGER PRIMARY KEY,head_json TEXT);
    INSERT INTO source_files VALUES('selected','intake_original'),('other','intake_original');
    INSERT INTO __record_state VALUES(1,'fictional-head');
    INSERT INTO app_meta VALUES('selected/head','before'),('other/head','retained'),
      ('revision','0'),('clinical_review_revision','0')`);
  installManagedDatabaseAuthorization(db);
  installManagedDatabaseFunctionRegistration(db);
  beforeObserver?.(db);
  t.after(() => db.close());
  const preprepared = db.prepare('UPDATE app_meta SET value=? WHERE key=?');
  ensureIntakeFrontierObserver(db);
  const captured = captureIntakeFrontierAttempts(db);
  assert.ok(captured);
  const ownerWrite = () => {
    const expected = expectIntakeFrontierMetaWrite(db, 'selected/head', ['update']);
    try {
      const result = preprepared.run('after', 'selected/head');
      finishIntakeFrontierMetaWrite(db, expected, result.changes === 1);
    } catch (error) {
      finishIntakeFrontierMetaWrite(db, expected, false);
      throw error;
    }
  };
  return { db, captured, ownerWrite, preprepared };
}

test('frontier observer preserves a previously installed deny policy', (t) => {
  let prepared: ReturnType<DatabaseSync['prepare']> | undefined;
  const f = fixture(t, (db) => {
    prepared = db.prepare("DELETE FROM app_meta WHERE key='other/head'");
    db.setAuthorizer((action) =>
      action === constants.SQLITE_DELETE ? constants.SQLITE_DENY : constants.SQLITE_OK,
    );
  });
  assert.ok(prepared);
  assert.throws(() => prepared!.run());
  assert.equal(
    f.db.prepare("SELECT value FROM app_meta WHERE key='other/head'").get()?.value,
    'retained',
  );
});

test('failed compact readmission cannot renew a revoked frontier', (t) => {
  const f = fixture(t);
  blockIntakeFrontierReadmission(f.db);
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
  assert.equal(captureIntakeFrontierAttempts(f.db), undefined);
  assert.throws(() => ensureIntakeFrontierObserver(f.db), /compact readmission is unavailable/);
});

test('failed compact readmission cannot install a frontier later', () => {
  const db = new DatabaseSync(':memory:');
  try {
    blockIntakeFrontierReadmission(db);
    installManagedDatabaseAuthorization(db);
    installManagedDatabaseFunctionRegistration(db);
    assert.throws(() => ensureIntakeFrontierObserver(db), /compact readmission is unavailable/);
  } finally {
    db.close();
  }
});

test('frontier observer sees DDL prepared before listener installation', (t) => {
  let prepared: ReturnType<DatabaseSync['prepare']> | undefined;
  const f = fixture(t, (db) => {
    prepared = db.prepare('CREATE TEMP TABLE unrelated_frontier_test(value TEXT)');
  });
  assert.ok(prepared);
  prepared.run();
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
});

test('registering another SQL function invalidates a protected frontier', (t) => {
  const f = fixture(t);
  assert.throws(() => f.db.function('json_extract', (_text: unknown, _path: unknown) => null));
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
});

test('case-insensitive private UDF replacement cannot be recertified without reinstall', (t) => {
  const f = fixture(t);
  const trigger = f.db
    .prepare(
      "SELECT sql FROM sqlite_temp_schema WHERE type='trigger' AND name LIKE '__intake_frontier_meta_update_%' LIMIT 1",
    )
    .get()?.sql;
  const functionName = String(trigger).match(/SELECT\s+(__intake_frontier_event_[a-f0-9]+)/)?.[1];
  assert.ok(functionName);
  f.db.function(
    functionName.toUpperCase(),
    (_table: unknown, _op: unknown, _before: unknown, _after: unknown) => null,
  );
  ensureIntakeFrontierObserver(f.db);
  const renewed = captureIntakeFrontierAttempts(f.db);
  assert.ok(renewed);
  f.preprepared.run('hidden', 'other/head');
  assert.equal(readIntakeFrontierSourceEquality(f.db, renewed), undefined);
});

test('frontier event history stays bounded across sequential accepted operations', (t) => {
  const f = fixture(t, (db) => {
    const insert = db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)');
    for (let index = 0; index < 102; index++) insert.run(`source-${index}/head`, 'before');
  });
  const oldest = f.captured;
  const update = f.db.prepare('UPDATE app_meta SET value=? WHERE key=?');
  for (let index = 0; index < 102; index++) {
    const before = captureIntakeFrontierAttempts(f.db);
    assert.ok(before);
    const sourceId = `source-${index}`;
    transaction(
      f.db,
      () => {
        const expected = expectIntakeFrontierMetaWrite(
          f.db,
          `${sourceId}/head`,
          ['update'],
          sourceId,
        );
        assert.ok(expected);
        const result = update.run('after', `${sourceId}/head`);
        finishIntakeFrontierMetaWrite(f.db, expected, result.changes === 1);
      },
      { actor: 'source-text' },
    );
    const latest = readIntakeFrontierAcceptedTransition(f.db, before);
    assert.ok(latest);
    assert.deepEqual(latest.headSourceIds, [sourceId]);
    assert.equal(latest.ordinaryTokens.length, 1);
  }
  assert.equal(readIntakeFrontierAcceptedTransition(f.db, oldest), undefined);
  assert.ok(captureIntakeFrontierAttempts(f.db));
});

test('head history preserves exactly 100 changed sources and refuses a 101st old interval', (t) => {
  const f = fixture(t, (db) => {
    const insert = db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)');
    for (let index = 0; index < 101; index++) insert.run(`head-${index}`, 'before');
  });
  const update = f.db.prepare('UPDATE app_meta SET value=? WHERE key=?');
  const write = (index: number) => {
    const key = `head-${index}`;
    const expected = expectIntakeFrontierMetaWrite(f.db, key, ['update'], `source-${index}`);
    assert.ok(expected);
    const result = update.run('after', key);
    finishIntakeFrontierMetaWrite(f.db, expected, result.changes === 1);
  };
  for (let index = 0; index < 100; index++) write(index);
  assert.equal(readIntakeFrontierSourceEquality(f.db, f.captured)?.headSourceIds.length, 100);
  const recent = captureIntakeFrontierAttempts(f.db);
  assert.ok(recent);
  write(100);
  assert.equal(readIntakeFrontierSourceEquality(f.db, f.captured), undefined);
  assert.deepEqual(readIntakeFrontierSourceEquality(f.db, recent)?.headSourceIds, ['source-100']);
});

test('ordinary outcome history refuses only snapshots older than its bounded window', (t) => {
  const f = fixture(t);
  const insert = f.db.prepare('INSERT INTO source_records VALUES(?,?)');
  for (let index = 0; index < 102; index++) {
    const recent = captureIntakeFrontierAttempts(f.db);
    assert.ok(recent);
    transaction(f.db, () => insert.run(`record-${index}`, 'selected'), { actor: 'source-text' });
    const outcome = readIntakeFrontierAcceptedTransition(f.db, recent);
    assert.ok(outcome);
    assert.equal(outcome.ordinaryTokens.length, 1);
    assert.deepEqual(outcome.headSourceIds, []);
  }
  assert.equal(readIntakeFrontierAcceptedTransition(f.db, f.captured), undefined);
  assert.ok(captureIntakeFrontierAttempts(f.db));
});

test('frontier observer permits read-only schema introspection but revokes a mutable PRAGMA', (t) => {
  const f = fixture(t);
  f.db.prepare('PRAGMA table_info(app_meta)').all();
  assert.ok(readIntakeFrontierAttempts(f.db, f.captured));
  f.db.exec('PRAGMA writable_schema=ON');
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
});

for (const sql of [
  "UPDATE __record_state SET head_json='forged' WHERE singleton=1",
  'DELETE FROM __record_state WHERE singleton=1',
  "INSERT OR REPLACE INTO __record_state VALUES(1,'forged')",
])
  test(`frontier observer refuses a direct durability row attempt: ${sql.split(' ')[0]}`, (t) => {
    let preprepared: ReturnType<DatabaseSync['prepare']> | undefined;
    const f = fixture(t, (db) => {
      preprepared = db.prepare(sql);
    });
    preprepared!.run();
    assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
  });

test('only the fixed durability publication may write its singleton state', (t) => {
  const f = fixture(t);
  transaction(
    f.db,
    () => {
      const expected = expectIntakeFrontierStateWrite(f.db);
      let written = false;
      try {
        written =
          f.db.prepare("INSERT OR REPLACE INTO __record_state VALUES(1,'next')").run().changes ===
          1;
      } finally {
        finishIntakeFrontierMetaWrite(f.db, expected, written);
      }
    },
    { actor: 'source-text' },
  );
  const interval = readIntakeFrontierAttempts(f.db, f.captured);
  assert.ok(interval);
  assert.equal(interval.attempts, interval.ownedWrites);
  assert.throws(() =>
    transaction(
      f.db,
      () => {
        const expected = expectIntakeFrontierStateWrite(f.db);
        let written = false;
        try {
          written =
            f.db.prepare("INSERT OR REPLACE INTO __record_state VALUES(1,'rolled-back')").run()
              .changes === 1;
        } finally {
          finishIntakeFrontierMetaWrite(f.db, expected, written);
        }
        throw Error('fictional rollback');
      },
      { actor: 'source-text' },
    ),
  );
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
});

test('only the fixed native clinical changeset call admits its exact PRAGMA pair', (t) => {
  const f = fixture(t);
  const changes = clinicalChangeset();
  transaction(
    f.db,
    () => {
      assert.equal(applyObservedClinicalProjectionChangeset(f.db, changes), true);
      f.ownerWrite();
    },
    { actor: 'source-text' },
  );
  const transition = readIntakeFrontierAcceptedTransition(f.db, f.captured);
  assert.ok(transition);
  assert.equal(transition.attempts, transition.ownedWrites);
  assert.equal(transition.ordinaryTokens.length, 1);
  f.db.exec('PRAGMA defer_foreign_keys=ON');
  assert.equal(readIntakeFrontierAcceptedTransition(f.db, f.captured), undefined);
});

test('the same PRAGMA outside the native changeset bracket revokes the frontier', (t) => {
  const f = fixture(t);
  f.db.exec('PRAGMA defer_foreign_keys=ON');
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
});

test('a clinical changeset cannot hide an unowned protected trigger write', (t) => {
  const f = fixture(t, (db) =>
    db.exec(`CREATE TRIGGER clinical_foreign_write AFTER INSERT ON source_records BEGIN
      UPDATE app_meta SET value='foreign' WHERE key='other/head';
    END`),
  );
  transaction(
    f.db,
    () => assert.equal(applyObservedClinicalProjectionChangeset(f.db, clinicalChangeset()), true),
    { actor: 'source-text' },
  );
  assert.equal(readIntakeFrontierAcceptedTransition(f.db, f.captured), undefined);
});

test('a clinical changeset conflict cannot gain frontier credit', (t) => {
  const f = fixture(t, (db) =>
    db.prepare('INSERT INTO source_records VALUES(?,?)').run('fictional-record', 'selected'),
  );
  transaction(
    f.db,
    () => assert.equal(applyObservedClinicalProjectionChangeset(f.db, clinicalChangeset()), false),
    { actor: 'source-text' },
  );
  assert.equal(readIntakeFrontierAcceptedTransition(f.db, f.captured), undefined);
});

test('replaced native changeset method cannot gain frontier credit', (t) => {
  const f = fixture(t);
  const changes = clinicalChangeset();
  const original = f.db.applyChangeset;
  f.db.applyChangeset = function (this: DatabaseSync, ...args) {
    return Reflect.apply(original, this, args);
  } as DatabaseSync['applyChangeset'];
  transaction(
    f.db,
    () => assert.equal(applyObservedClinicalProjectionChangeset(f.db, changes), true),
    { actor: 'source-text' },
  );
  assert.equal(readIntakeFrontierAcceptedTransition(f.db, f.captured), undefined);
});

test('clinical changeset failure and outer rollback never advance a frontier', (t) => {
  const f = fixture(t);
  assert.throws(() =>
    transaction(
      f.db,
      () => applyObservedClinicalProjectionChangeset(f.db, new Uint8Array([1, 2, 3])),
      { actor: 'source-text' },
    ),
  );
  assert.equal(readIntakeFrontierAcceptedTransition(f.db, f.captured), undefined);
  ensureIntakeFrontierObserver(f.db);
  const renewed = captureIntakeFrontierAttempts(f.db);
  assert.ok(renewed);
  assert.throws(() =>
    transaction(
      f.db,
      () => {
        assert.equal(applyObservedClinicalProjectionChangeset(f.db, clinicalChangeset()), true);
        throw Error('fictional cancellation');
      },
      { actor: 'source-text' },
    ),
  );
  assert.equal(readIntakeFrontierAcceptedTransition(f.db, renewed), undefined);
});

test('frontier observer renews one function and trigger set before a new cold proof', (t) => {
  const f = fixture(t);
  const before = f.db
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_temp_master WHERE name LIKE '__intake_frontier_%'",
    )
    .get()?.count;
  f.preprepared.run('foreign', 'other/head');
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
  ensureIntakeFrontierObserver(f.db);
  const renewed = captureIntakeFrontierAttempts(f.db);
  assert.ok(renewed);
  assert.notEqual(renewed.identity, f.captured.identity);
  assert.equal(
    f.db
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_temp_master WHERE name LIKE '__intake_frontier_%'",
      )
      .get()?.count,
    before,
  );
  transaction(f.db, f.ownerWrite, { actor: 'source-text' });
  const result = readIntakeFrontierAttempts(f.db, renewed);
  assert.ok(result);
  assert.equal(result.attempts, 2);
  assert.equal(result.ownedWrites, 2);
  assert.deepEqual(result.headSourceIds, []);
  assert.equal(result.ordinaryTokens.length, 1);
});

test('renewing a frontier rearms precompiled direct source-text tracking writes', (t) => {
  const f = fixture(t, (db) =>
    db.exec('CREATE TEMP TABLE __source_text_dirty(source_id TEXT PRIMARY KEY)'),
  );
  const direct = f.db.prepare(
    "INSERT OR IGNORE INTO temp.__source_text_dirty(source_id) VALUES('selected')",
  );
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
  ensureIntakeFrontierObserver(f.db);
  const renewed = captureIntakeFrontierAttempts(f.db);
  assert.ok(renewed);
  assert.equal(direct.run().changes, 1);
  assert.equal(readIntakeFrontierAttempts(f.db, renewed), undefined);
  assert.equal(
    intakeFrontierAttemptCounts(f.db)?.firstRevocation,
    'unowned source-text tracking write',
  );
  ensureIntakeFrontierObserver(f.db);
  const repeated = captureIntakeFrontierAttempts(f.db);
  assert.ok(repeated);
  assert.equal(direct.run().changes, 0);
  assert.equal(readIntakeFrontierAttempts(f.db, repeated), undefined);
  assert.equal(
    intakeFrontierAttemptCounts(f.db)?.firstRevocation,
    'unowned source-text tracking write',
  );
});

test('frontier observer counts only one fixed owned write, including preprepared SQL', (t) => {
  const f = fixture(t);
  transaction(f.db, f.ownerWrite, { actor: 'source-text' });
  const result = readIntakeFrontierAttempts(f.db, f.captured);
  assert.ok(result);
  assert.equal(result.attempts, 2);
  assert.equal(result.ownedWrites, 2);
  assert.deepEqual(result.headSourceIds, []);
  assert.equal(result.ordinaryTokens.length, 1);
});

test('selected lookup dirty credit requires the original fixed head write and key', (t) => {
  const f = fixture(t, (db) => {
    db.exec(`CREATE TEMP TABLE __intake_lookup_authorities(authority_key TEXT PRIMARY KEY,source_id TEXT);
      CREATE TEMP TABLE __intake_lookup_dirty(source_id TEXT PRIMARY KEY);
      INSERT INTO temp.__intake_lookup_authorities VALUES('selected/head','selected');
      CREATE TEMP TRIGGER __intake_lookup_authority_UPDATE AFTER UPDATE ON main.app_meta BEGIN
        INSERT INTO __intake_lookup_dirty SELECT source_id FROM __intake_lookup_authorities
          WHERE authority_key=NEW.key AND NOT EXISTS(
            SELECT 1 FROM __intake_lookup_dirty WHERE source_id='selected');
      END;`);
  });
  transaction(
    f.db,
    () => {
      const token = currentTransactionToken(f.db);
      assert.ok(token);
      assert.equal(
        readIntakeFrontierOwnedLookupDirtyWrite(
          f.db,
          f.captured,
          token,
          'selected',
          'selected/head',
        ),
        0,
      );
      const expected = expectIntakeFrontierMetaWrite(f.db, 'selected/head', ['update'], 'selected');
      assert.ok(expected);
      const result = f.preprepared.run('after', 'selected/head');
      finishIntakeFrontierMetaWrite(f.db, expected, result.changes === 1);
      assert.equal(
        readIntakeFrontierOwnedLookupDirtyWrite(
          f.db,
          f.captured,
          token,
          'selected',
          'selected/head',
        ),
        1,
      );
      assert.equal(
        readIntakeFrontierOwnedLookupDirtyWrite(f.db, f.captured, token, 'selected', 'other/head'),
        undefined,
      );
    },
    { actor: 'source-text' },
  );
});

for (const preinsert of [false, true])
  test(`precompiled direct lookup dirty ${preinsert ? 'no-op' : 'insert'} never mints a receipt`, (t) => {
    let direct: ReturnType<DatabaseSync['prepare']> | undefined;
    const f = fixture(t, (db) => {
      db.exec('CREATE TEMP TABLE __intake_lookup_dirty(source_id TEXT PRIMARY KEY)');
      if (preinsert) db.prepare('INSERT INTO temp.__intake_lookup_dirty VALUES(?)').run('selected');
      direct = db.prepare('INSERT OR IGNORE INTO temp.__intake_lookup_dirty VALUES(?)');
    });
    const statement = direct;
    assert.ok(statement);
    transaction(
      f.db,
      () => {
        const token = currentTransactionToken(f.db);
        assert.ok(token);
        assert.equal(statement.run('selected').changes, preinsert ? 0 : 1);
        assert.equal(
          readIntakeFrontierOwnedLookupDirtyWrite(
            f.db,
            f.captured,
            token,
            'selected',
            'selected/head',
          ),
          undefined,
        );
        assert.equal(intakeFrontierAttemptCounts(f.db)?.revoked, true);
      },
      { actor: 'source-text' },
    );
  });

test('unrelated TEMP work needs the exact later owner outcome and cannot credit a no-outcome read', (t) => {
  const f = fixture(t, (db) => db.exec('CREATE TEMP TABLE unrelated_work(value TEXT)'));
  f.db.prepare('INSERT INTO temp.unrelated_work VALUES(?)').run('fictional');
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
  assert.equal(readIntakeFrontierAcceptedTransition(f.db, f.captured), undefined);
  transaction(f.db, f.ownerWrite, { actor: 'source-text' });
  const transition = readIntakeFrontierAcceptedTransition(f.db, f.captured);
  assert.ok(transition);
  assert.equal(transition.attempts, transition.ownedWrites);
  assert.equal(transition.ordinaryTokens.length, 1);
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
  f.db.prepare('INSERT INTO temp.unrelated_work VALUES(?)').run('later');
  assert.equal(readIntakeFrontierAcceptedTransition(f.db, f.captured), undefined);
});

test('disposable lookup projection writes cannot authorize a native outcome', (t) => {
  const f = fixture(t, (db) =>
    db.exec(
      'CREATE TABLE __record_intake_lookup_groups(value TEXT); CREATE TEMP TABLE __intake_lookup_dirty(value TEXT)',
    ),
  );
  f.db.prepare('INSERT INTO __record_intake_lookup_groups VALUES(?)').run('forged');
  transaction(f.db, f.ownerWrite, { actor: 'source-text' });
  assert.equal(readIntakeFrontierAcceptedTransition(f.db, f.captured), undefined);
});

test('frontier observer retains only bounded changed head identities since capture', (t) => {
  const f = fixture(t);
  transaction(
    f.db,
    () => {
      const expected = expectIntakeFrontierMetaWrite(f.db, 'selected/head', ['update'], 'selected');
      try {
        const result = f.preprepared.run('after', 'selected/head');
        finishIntakeFrontierMetaWrite(f.db, expected, result.changes === 1);
      } catch (error) {
        finishIntakeFrontierMetaWrite(f.db, expected, false);
        throw error;
      }
    },
    { actor: 'source-text' },
  );
  const result = readIntakeFrontierAttempts(f.db, f.captured);
  assert.ok(result);
  assert.equal(result.attempts, 2);
  assert.equal(result.ownedWrites, 2);
  assert.deepEqual(result.headSourceIds, ['selected']);
  assert.equal(result.ordinaryTokens.length, 1);
});

for (const mode of ['other-ABA', 'selected-ABA', 'source-insert-delete', 'rollback'])
  test(`frontier observer revokes ${mode} despite a later matching owner write`, (t) => {
    const f = fixture(t);
    f.db.exec('BEGIN');
    if (mode === 'other-ABA' || mode === 'selected-ABA') {
      const key = mode === 'other-ABA' ? 'other/head' : 'selected/head';
      const original = mode === 'other-ABA' ? 'retained' : 'before';
      f.preprepared.run('foreign', key);
      f.preprepared.run(original, key);
    } else if (mode === 'source-insert-delete') {
      f.db.exec("INSERT INTO source_files VALUES('extra','intake_original')");
      f.db.exec("DELETE FROM source_files WHERE id='extra'");
    } else f.preprepared.run('foreign', 'other/head');
    if (mode !== 'rollback') f.ownerWrite();
    f.db.exec(mode === 'rollback' ? 'ROLLBACK' : 'COMMIT');
    assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
  });

test('frontier observer refuses a hidden ABA after TEMP trigger recreation and schema reset', (t) => {
  const f = fixture(t);
  const trigger = f.db
    .prepare(
      "SELECT name,sql FROM sqlite_temp_master WHERE type='trigger' AND name LIKE '__intake_frontier_meta_update_%'",
    )
    .get();
  assert.equal(typeof trigger?.name, 'string');
  assert.equal(typeof trigger?.sql, 'string');
  f.db.exec(`DROP TRIGGER ${trigger!.name}`);
  f.preprepared.run('foreign', 'other/head');
  f.preprepared.run('retained', 'other/head');
  f.db.exec(String(trigger!.sql));
  f.db.exec(`PRAGMA temp.schema_version=${f.captured.tempSchema}`);
  f.ownerWrite();
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
});

test('frontier observer refuses direct function use and supported replacement', (t) => {
  const f = fixture(t);
  const trigger = f.db
    .prepare(
      "SELECT sql FROM sqlite_temp_master WHERE type='trigger' AND name LIKE '__intake_frontier_meta_update_%'",
    )
    .get();
  const name = String(trigger?.sql).match(/SELECT (__intake_frontier_event_[0-9a-f]+)/)?.[1];
  assert.ok(name);
  f.db.prepare(`SELECT ${name}('app_meta','update','selected/head','selected/head')`).get();
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
});

for (const mode of ['function', 'authorizer'])
  test(`frontier observer revokes ${mode} replacement without schema drift`, (t) => {
    const f = fixture(t);
    if (mode === 'function') {
      const trigger = f.db
        .prepare(
          "SELECT sql FROM sqlite_temp_master WHERE type='trigger' AND name LIKE '__intake_frontier_meta_update_%'",
        )
        .get();
      const name = String(trigger?.sql).match(/SELECT (__intake_frontier_event_[0-9a-f]+)/)?.[1];
      assert.ok(name);
      f.db.function(name, (_table, _operation, _before, _after) => null);
    } else f.db.setAuthorizer(null);
    f.ownerWrite();
    assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
  });

test('frontier observer certifies only completed owner TEMP maintenance', (t) => {
  const f = fixture(t);
  const preparation = beginIntakeFrontierAuxiliaryPreparation(f.db, 'ownership');
  assert.ok(preparation);
  execIntakeFrontierAuxiliarySQL(
    f.db,
    preparation,
    'CREATE TEMP TABLE __ownership_decision_index_state(singleton INTEGER PRIMARY KEY,generation INTEGER)',
  );
  execIntakeFrontierAuxiliarySQL(
    f.db,
    preparation,
    'INSERT INTO __ownership_decision_index_state VALUES(1,0)',
  );
  const insert = prepareIntakeFrontierAuxiliaryInsert(
    f.db,
    preparation,
    'INSERT INTO __ownership_decision_index_state VALUES(?,?)',
  );
  runIntakeFrontierAuxiliaryInsert(f.db, preparation, insert, [2, 0]);
  assert.equal(finishIntakeFrontierAuxiliaryPreparation(f.db, preparation, true), true);
  const result = readIntakeFrontierAttempts(f.db, f.captured);
  assert.ok(result);
  assert.equal(result.attempts, 0);
  assert.equal(result.ownedWrites, 0);
});

test('frontier observer revokes foreign TEMP writes across auxiliary host turns', (t) => {
  const f = fixture(t);
  const preparation = beginIntakeFrontierAuxiliaryPreparation(f.db, 'ownership');
  assert.ok(preparation);
  execIntakeFrontierAuxiliarySQL(
    f.db,
    preparation,
    'CREATE TEMP TABLE __ownership_decision_index_state(singleton INTEGER PRIMARY KEY,generation INTEGER)',
  );
  f.db.exec('CREATE TEMP TABLE unrelated_frontier(value TEXT)');
  assert.equal(finishIntakeFrontierAuxiliaryPreparation(f.db, preparation, true), false);
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
});

test('frontier observer revokes protected writes inside an auxiliary statement', (t) => {
  const f = fixture(t);
  const preparation = beginIntakeFrontierAuxiliaryPreparation(f.db, 'clinical-source');
  assert.ok(preparation);
  const update = prepareIntakeFrontierAuxiliaryInsert(
    f.db,
    preparation,
    'UPDATE app_meta SET value=? WHERE key=?',
  );
  runIntakeFrontierAuxiliaryInsert(f.db, preparation, update, ['foreign', 'other/head']);
  assert.equal(finishIntakeFrontierAuxiliaryPreparation(f.db, preparation, true), false);
  assert.equal(readIntakeFrontierAttempts(f.db, f.captured), undefined);
});

for (const name of [
  'app_meta',
  'SOURCE_FILES',
  'APP_META',
  '__RECORD_STATE',
  '__RECORD_INTAKE_LOOKUP_SOURCES',
])
  test(`frontier observer refuses a preexisting protected TEMP shadow: ${name}`, (t) => {
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    db.exec(
      'CREATE TABLE source_files(id TEXT PRIMARY KEY); CREATE TABLE app_meta(key TEXT PRIMARY KEY); CREATE TABLE __record_state(singleton INTEGER PRIMARY KEY)',
    );
    installManagedDatabaseAuthorization(db);
    installManagedDatabaseFunctionRegistration(db);
    db.exec(`CREATE TEMP TABLE ${name}(key TEXT PRIMARY KEY)`);
    ensureIntakeFrontierObserver(db);
    assert.equal(captureIntakeFrontierAttempts(db), undefined);
  });

test('frontier observer refuses a peer write without a local attempted event', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'frontier-peer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.db');
  const db = new DatabaseSync(path);
  const peer = new DatabaseSync(path);
  t.after(() => {
    peer.close();
    db.close();
  });
  db.exec(
    'CREATE TABLE source_files(id TEXT PRIMARY KEY); CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE __record_state(singleton INTEGER PRIMARY KEY)',
  );
  installManagedDatabaseAuthorization(db);
  installManagedDatabaseFunctionRegistration(db);
  ensureIntakeFrontierObserver(db);
  const captured = captureIntakeFrontierAttempts(db);
  assert.ok(captured);
  peer.exec("INSERT INTO source_files VALUES('peer-original')");
  assert.equal(readIntakeFrontierAttempts(db, captured), undefined);
});
