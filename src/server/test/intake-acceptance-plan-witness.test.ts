import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants, DatabaseSync, StatementSync } from 'node:sqlite';
import {
  openDatabase,
  readOrdinaryCommitCursor,
  observeManagedDatabaseAuthorization,
  transaction,
} from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import {
  beginIntakeFrontierAuxiliaryPreparation,
  execIntakeFrontierAuxiliarySQL,
  finishIntakeFrontierAuxiliaryPreparation,
  readIntakeFrontierAuxiliaryChanges,
} from '../intake-lookup-frontier-observer.ts';
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-plan-witness-')),
    path = ensureProfileDirectories(root, 'fictional-witness').database,
    db = openDatabase(path, 'fictional-witness');
  memoryRecordAuthority(db);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec('CREATE TEMP TABLE __duplicate_evidence_fixture(value TEXT)');
  // Normal function registration can revoke the broader source-frontier cache.
  db.function('fictional_auxiliary_function', () => 0);
  return { db, path };
}
test('internal ordinary count probes cannot invoke policy or observer SQL', (t) => {
  const { db } = fixture(t);
  readOrdinaryCommitCursor(db);
  let armed = false,
    observerCalls = 0,
    policyCalls = 0;
  const probe = (action: number, _name: string | null, detail: string | null) =>
    action === constants.SQLITE_FUNCTION && detail === 'total_changes';
  const dispose = observeManagedDatabaseAuthorization(
    db,
    (...args) => {
      if (armed && probe(...(args.slice(0, 3) as [number, string | null, string | null]))) {
        observerCalls++;
        db.prepare(
          "UPDATE app_meta SET value=value||' observer' WHERE key='owner_profile_id'",
        ).run();
      }
    },
    () => {},
  );
  db.setAuthorizer((action, name, detail) => {
    if (armed && probe(action, name, detail)) {
      policyCalls++;
      db.prepare("UPDATE app_meta SET value=value||' policy' WHERE key='owner_profile_id'").run();
    }
    return constants.SQLITE_OK;
  });
  try {
    transaction(db, () => {
      db.prepare("INSERT INTO app_meta(key,value) VALUES('fictional-count','one')").run();
      armed = true;
    });
    const cursor = readOrdinaryCommitCursor(db);
    assert.equal(cursor.changes, cursor.settledChanges);
    assert.equal(observerCalls, 0);
    assert.equal(policyCalls, 0);
    db.prepare('SELECT total_changes() AS n').get();
    assert.equal(observerCalls, 1);
    assert.equal(policyCalls, 1);
    assert.notEqual(readOrdinaryCommitCursor(db).changes, cursor.settledChanges);
  } finally {
    armed = false;
    db.setAuthorizer(null);
    dispose?.();
  }
});
test('ordinary count rejects native-prototype builtin substitution before calling it', (t) => {
  const { db } = fixture(t);
  readOrdinaryCommitCursor(db);
  let calls = 0;
  DatabaseSync.prototype.function.call(db, 'total_changes', () => {
    calls++;
    return 0;
  });
  assert.throws(() => readOrdinaryCommitCursor(db), /native total_changes/);
  assert.equal(calls, 0);
});
test('a completed disposable TEMP builder accounts only its exact auxiliary changes', (t) => {
  const { db } = fixture(t),
    before = readIntakeFrontierAuxiliaryChanges(db),
    cursor = readOrdinaryCommitCursor(db),
    preparation = beginIntakeFrontierAuxiliaryPreparation(db, 'duplicate-evidence');
  assert.ok(preparation);
  execIntakeFrontierAuxiliarySQL(
    db,
    preparation,
    "INSERT INTO __duplicate_evidence_fixture VALUES('fictional')",
  );
  finishIntakeFrontierAuxiliaryPreparation(db, preparation, true);
  assert.equal(readIntakeFrontierAuxiliaryChanges(db), before + 1n);
  const after = readOrdinaryCommitCursor(db);
  assert.equal(after.serial, cursor.serial);
  assert.equal(after.changes, after.settledChanges);
});
for (const mutation of [
  'precompiled-main',
  'trigger-main',
  'peer',
  'schema',
  'function',
  'incomplete',
  'after-helper',
  'nested-callback',
])
  test(`auxiliary accounting refuses ${mutation} effects and always disposes its observer`, (t) => {
    const { db, path } = fixture(t),
      before = readIntakeFrontierAuxiliaryChanges(db);
    const external = db.prepare(
      "UPDATE app_meta SET value=value||' fictional' WHERE key='owner_profile_id'",
    );
    if (mutation === 'trigger-main')
      db.exec(
        "CREATE TEMP TRIGGER fictional_auxiliary_trigger AFTER INSERT ON __duplicate_evidence_fixture BEGIN UPDATE app_meta SET value=value||' fictional' WHERE key='owner_profile_id'; END;",
      );
    let dispose: (() => void) | undefined;
    const preparation = beginIntakeFrontierAuxiliaryPreparation(db, 'duplicate-evidence');
    assert.ok(preparation);
    let nested = false;
    if (mutation === 'nested-callback')
      dispose = observeManagedDatabaseAuthorization(
        db,
        (_action, name) => {
          if (!nested && name === '__duplicate_evidence_fixture') {
            nested = true;
            external.run();
          }
        },
        () => {},
      );
    try {
      try {
        execIntakeFrontierAuxiliarySQL(
          db,
          preparation,
          "INSERT INTO __duplicate_evidence_fixture VALUES('fictional')",
        );
      } catch {
        assert.ok(mutation === 'nested-callback');
      }
      if (mutation === 'precompiled-main' || mutation === 'after-helper') external.run();
      if (mutation === 'peer') {
        const peer = new DatabaseSync(path);
        try {
          peer
            .prepare("UPDATE app_meta SET value=value||' fictional' WHERE key='owner_profile_id'")
            .run();
        } finally {
          peer.close();
        }
      }
      if (mutation === 'schema') db.exec('CREATE TABLE fictional_unowned(value TEXT)');
      if (mutation === 'function') db.function('fictional_changed_auxiliary', () => 1);
    } finally {
      dispose?.();
      finishIntakeFrontierAuxiliaryPreparation(db, preparation, mutation !== 'incomplete');
    }
    assert.equal(readIntakeFrontierAuxiliaryChanges(db), before);
    // A later builder is independent; failed scopes cannot leave an active observer.
    const next = beginIntakeFrontierAuxiliaryPreparation(db, 'duplicate-evidence');
    assert.ok(next);
    finishIntakeFrontierAuxiliaryPreparation(db, next, false);
  });

for (const additional of [false, true])
  test(`disposable lookup accounting ${additional ? 'refuses additional main effects' : 'counts exact owned rows only'}`, async (t) => {
    const { db } = fixture(t);
    const { prepareIntakeLookupIndices } = await import('../intake-lookup-projection.ts');
    const { ownedIntakeProjectionWrite, readIntakeProjectionChanges } =
      await import('../intake-lookup-projection-witness.ts');
    await prepareIntakeLookupIndices(db);
    const before = readIntakeProjectionChanges(db),
      cursor = readOrdinaryCommitCursor(db);
    ownedIntakeProjectionWrite(
      db,
      { table: 'payloads', operations: ['insert'], key: 'fictional-payload' },
      () => {
        if (additional)
          db.prepare(
            "UPDATE app_meta SET value=value||' fictional' WHERE key='owner_profile_id'",
          ).run();
        return db
          .prepare('INSERT INTO __record_intake_lookup_payloads VALUES(?,?)')
          .run('fictional-payload', '{}');
      },
    );
    assert.equal(readIntakeProjectionChanges(db), before + (additional ? 0n : 1n));
    const after = readOrdinaryCommitCursor(db);
    assert.equal(after.serial, cursor.serial);
    assert.equal(after.changes === after.settledChanges, !additional);
  });

for (const phase of ['opening', 'closing'])
  test(`auxiliary accounting refuses main effects from ${phase} probes`, (t) => {
    const { db } = fixture(t),
      before = readIntakeFrontierAuxiliaryChanges(db);
    let armed = phase === 'opening';
    const dispose = observeManagedDatabaseAuthorization(
      db,
      (action, name) => {
        if (armed && action === constants.SQLITE_PRAGMA && name === 'data_version') {
          armed = false;
          db.prepare(
            "UPDATE app_meta SET value=value||' fictional' WHERE key='owner_profile_id'",
          ).run();
        }
      },
      () => {},
    );
    try {
      const preparation = beginIntakeFrontierAuxiliaryPreparation(db, 'duplicate-evidence');
      assert.ok(preparation);
      execIntakeFrontierAuxiliarySQL(
        db,
        preparation,
        "INSERT INTO __duplicate_evidence_fixture VALUES('fictional')",
      );
      armed = phase === 'closing';
      finishIntakeFrontierAuxiliaryPreparation(db, preparation, true);
      assert.equal(readIntakeFrontierAuxiliaryChanges(db), before);
    } finally {
      dispose?.();
    }
  });

test('lookup accounting refuses closing callback effects with spoofed matching events', async (t) => {
  const { db } = fixture(t);
  const { prepareIntakeLookupIndices } = await import('../intake-lookup-projection.ts');
  const { ownedIntakeProjectionWrite, readIntakeProjectionChanges } =
    await import('../intake-lookup-projection-witness.ts');
  await prepareIntakeLookupIndices(db);
  const trigger = String(
    db
      .prepare(
        "SELECT sql FROM sqlite_temp_schema WHERE type='trigger' AND name LIKE '__intake_projection_payloads_insert_%'",
      )
      .get()!.sql,
  );
  const functionName = /SELECT (__intake_projection_event_[a-z0-9]+)\(/.exec(trigger)![1];
  const before = readIntakeProjectionChanges(db);
  let armed = false;
  const dispose = observeManagedDatabaseAuthorization(
    db,
    (action, name) => {
      if (armed && action === constants.SQLITE_PRAGMA && name === 'data_version') {
        armed = false;
        db.prepare(
          "UPDATE app_meta SET value=value||' fictional' WHERE key='owner_profile_id'",
        ).run();
        db.prepare(`SELECT ${functionName}('payloads','insert','fictional-payload',NULL)`).get();
      }
    },
    () => {},
  );
  try {
    ownedIntakeProjectionWrite(
      db,
      { table: 'payloads', operations: ['insert'], key: 'fictional-payload' },
      () => {
        const result = db
          .prepare('INSERT INTO __record_intake_lookup_payloads VALUES(?,?)')
          .run('fictional-payload', '{}');
        armed = true;
        return result;
      },
    );
    assert.equal(readIntakeProjectionChanges(db), before);
  } finally {
    dispose?.();
  }
});
for (const mutation of ['none', 'trigger', 'policy', 'closing', 'public-methods', 'raw'])
  test(`exact TEMP lookup reconciliation accounts safely with ${mutation}`, async (t) => {
    const { db } = fixture(t);
    const { prepareIntakeLookupIndices } = await import('../intake-lookup-projection.ts');
    const { runIntakeProjectionAuxiliary, readIntakeProjectionChanges } =
      await import('../intake-lookup-projection-witness.ts');
    await prepareIntakeLookupIndices(db);
    db.prepare('INSERT INTO temp.__intake_lookup_dirty VALUES(?)').run('fictional-temp-row');
    if (mutation === 'trigger')
      db.exec(
        "CREATE TEMP TRIGGER fictional_temp_effect AFTER DELETE ON __intake_lookup_dirty BEGIN UPDATE app_meta SET value=value||' fictional' WHERE key='owner_profile_id'; END",
      );
    const before = readIntakeProjectionChanges(db);
    let armed = false,
      closing = 0;
    const originalPrepare = db.prepare,
      originalRun = StatementSync.prototype.run;
    const dispose = observeManagedDatabaseAuthorization(
      db,
      (action, name) => {
        if (
          (mutation === 'policy' &&
            !armed &&
            action === constants.SQLITE_DELETE &&
            name === '__intake_lookup_dirty') ||
          (mutation === 'closing' &&
            action === constants.SQLITE_PRAGMA &&
            name === 'data_version' &&
            ++closing === 2)
        ) {
          armed = true;
          db.prepare(
            "UPDATE app_meta SET value=value||' fictional' WHERE key='owner_profile_id'",
          ).run();
        }
      },
      () => {},
    );
    if (mutation === 'public-methods') {
      db.prepare = function (sql) {
        if (sql.startsWith('DELETE FROM temp.__intake_lookup_dirty'))
          throw Error('public prepare must not execute');
        return originalPrepare.call(this, sql);
      };
      StatementSync.prototype.run = function (...args) {
        if (this.sourceSQL.startsWith('DELETE FROM temp.__intake_lookup_dirty'))
          throw Error('public run must not execute');
        return Reflect.apply(originalRun, this, args);
      };
    }
    try {
      if (mutation === 'raw')
        db.prepare('DELETE FROM temp.__intake_lookup_dirty WHERE source_id=?').run(
          'fictional-temp-row',
        );
      else runIntakeProjectionAuxiliary(db, 'removeDirty', ['fictional-temp-row']);
      assert.equal(
        readIntakeProjectionChanges(db),
        before + (['none', 'public-methods'].includes(mutation) ? 1n : 0n),
      );
    } finally {
      db.prepare = originalPrepare;
      StatementSync.prototype.run = originalRun;
      dispose?.();
    }
  });

test('queue transition TEMP maintenance is counted while raw queue writes remain unowned', (t) => {
  const { db } = fixture(t);
  db.exec('CREATE TEMP TABLE __intake_queue_transitions(source TEXT)');
  transaction(db, () => {});
  const before = readOrdinaryCommitCursor(db);
  const preparation = beginIntakeFrontierAuxiliaryPreparation(db, 'queue-transition');
  execIntakeFrontierAuxiliarySQL(
    db,
    preparation,
    "INSERT INTO temp.__intake_queue_transitions VALUES('Fictional transition')",
  );
  finishIntakeFrontierAuxiliaryPreparation(db, preparation, true);
  const after = readOrdinaryCommitCursor(db);
  assert.equal(after.changes, before.changes);
  assert.equal(after.changes, after.settledChanges);
  db.prepare(
    "INSERT INTO temp.__intake_queue_transitions VALUES('Unowned fictional transition')",
  ).run();
  assert.notEqual(readOrdinaryCommitCursor(db).changes, after.settledChanges);
});
for (const complete of [false, true])
  test(`queue transition credit refuses ${complete ? 'triggered main writes' : 'an incomplete builder'}`, (t) => {
    const { db } = fixture(t);
    db.exec('CREATE TEMP TABLE __intake_queue_transitions(source TEXT)');
    if (complete)
      db.exec(
        "CREATE TEMP TRIGGER fictional_queue_write AFTER INSERT ON __intake_queue_transitions BEGIN UPDATE app_meta SET value=value||' Fictional callback' WHERE key='owner_profile_id'; END",
      );
    const before = readIntakeFrontierAuxiliaryChanges(db);
    const preparation = beginIntakeFrontierAuxiliaryPreparation(db, 'queue-transition');
    execIntakeFrontierAuxiliarySQL(
      db,
      preparation,
      "INSERT INTO temp.__intake_queue_transitions VALUES('Fictional transition')",
    );
    finishIntakeFrontierAuxiliaryPreparation(db, preparation, complete);
    assert.equal(readIntakeFrontierAuxiliaryChanges(db), before);
  });

test('the actual queue transition writer certifies its changed TEMP rows', async (t) => {
  const { db } = fixture(t);
  const { uploadIntake, ensureNativeIntakeSchema } = await import('../intake.ts');
  const { openIntakeCollectionEnvelope } = await import('../intake-collection-envelope.ts');
  const { prepareCollectionQueueTransitions, recordCollectionQueueTransition } =
    await import('../intake-queue-transitions.ts');
  const root = mkdtempSync(join(tmpdir(), 'fictional-queue-transition-'));
  ensureProfileDirectories(root, 'fictional-witness');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = uploadIntake(db, root, 'fictional-witness', {
    filename: 'fictional-transition.jsonl',
    bytes: Buffer.from(
      JSON.stringify({
        format: 'health-record-v1',
        id: 'fictional-transition',
        kind: 'document',
        payload: { text: 'Fictional queue transition' },
        provenance: {
          capturedVia: 'Fictional export',
          sourceSystem: 'Fictional fixture',
          sourceRecordId: 'fictional-transition',
          evidenceClass: 'provider_export',
          locator: 'page 1',
        },
        coverage: { status: 'complete_response', notes: [] },
      }),
    ),
  });
  await ensureNativeIntakeSchema(db, 'fictional-witness', source.id);
  prepareCollectionQueueTransitions(db);
  const reader = openIntakeCollectionEnvelope(db, { id: source.id });
  const input = {
    reader,
    logical: { ...reader.logical, domainVersion: reader.logical.domainVersion + 1 },
  } as Parameters<typeof recordCollectionQueueTransition>[2];
  const before = readOrdinaryCommitCursor(db);
  recordCollectionQueueTransition(db, { id: source.id }, input, {
    affected: {
      candidateChanges: [],
      questionAddresses: [],
      reportGroupAddresses: [],
      proposalIds: [],
    },
  });
  const after = readOrdinaryCommitCursor(db);
  assert.equal(db.prepare('SELECT count(*) n FROM temp.__intake_queue_transitions').get()!.n, 1);
  assert.equal(
    db.prepare('SELECT count(*) n FROM temp.__intake_queue_transitions_effects').get()!.n,
    1,
  );
  assert.equal(after.changes, before.changes);
  assert.equal(after.changes, after.settledChanges);
});

for (const statement of [
  'seedDirtySources',
  'seedDirtyProjected',
  'clearAuthorities',
  'seedAuthorities',
] as const)
  for (const extraMain of [false, true])
    test(`cold lookup TEMP ${statement} ${extraMain ? 'refuses trigger side effects' : 'credits exact owned rows'}`, async (t) => {
      const { db } = fixture(t);
      const { prepareIntakeLookupIndices } = await import('../intake-lookup-projection.ts');
      const { runIntakeProjectionAuxiliary, readIntakeProjectionChanges } =
        await import('../intake-lookup-projection-witness.ts');
      await prepareIntakeLookupIndices(db);
      transaction(db, () =>
        db
          .prepare(
            "INSERT INTO source_files(id,path,sha256,bytes,kind) VALUES('fictional-cold-source','fictional.txt',?,0,'fictional')",
          )
          .run('1'.repeat(64)),
      );
      db.prepare(
        "INSERT INTO __record_intake_lookup_sources(source_id,source_order,kind,authority_key) VALUES('fictional-cold-source',1,'fictional','fictional-authority')",
      ).run();
      db.exec('DELETE FROM temp.__intake_lookup_dirty');
      const target = statement.includes('Authorities')
        ? '__intake_lookup_authorities'
        : '__intake_lookup_dirty';
      if (statement === 'clearAuthorities')
        db.prepare(
          "INSERT INTO temp.__intake_lookup_authorities VALUES('fictional-authority','fictional-cold-source')",
        ).run();
      if (extraMain)
        db.exec(
          `CREATE TEMP TRIGGER fictional_cold_side_effect AFTER ${statement === 'clearAuthorities' ? 'DELETE' : 'INSERT'} ON ${target} BEGIN UPDATE app_meta SET value=value||' Fictional side effect' WHERE key='owner_profile_id'; END`,
        );
      const before = readIntakeProjectionChanges(db);
      runIntakeProjectionAuxiliary(db, statement, []);
      assert.equal(readIntakeProjectionChanges(db), before + (extraMain ? 0n : 1n));
    });
