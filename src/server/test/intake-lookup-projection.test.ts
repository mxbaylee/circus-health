import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { constants, DatabaseSync } from 'node:sqlite';
import {
  observeDatabaseClose,
  observeManagedDatabaseAuthorization,
  openDatabase,
  transaction,
} from '../database.ts';
import {
  maximumReportDiscoveryOrder,
  retainedReportAcceptance,
  intakeIdentityConfirmations,
} from '../intake-state-access.ts';
import {
  clearIntakeLookupCache,
  intakeLookupCounters,
  prepareIntakeLookupProjection,
  iterateIntakeIdentityReferences,
} from '../intake-lookup-projection.ts';
import {
  ensureIntakeProjectionWitness,
  projectionWitnessRevision,
  sealIntakeProjectionWitness,
} from '../intake-lookup-projection-witness.ts';
import {
  memoryRecordAuthority,
  registerRawIntakeFixture,
  writeIntakeFixtureEnvelope,
} from './helpers/intake-authority-fixture.ts';
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-lookup-'));
  const db = openDatabase(join(root, 'cache.sqlite'), 'fictional-profile');
  const authority = memoryRecordAuthority(db);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const body = (n: number) =>
    JSON.stringify({
      intake: {
        workflow: {
          reportGroups: [{ discoveryOrder: n }],
          reportAcceptances: [{ receipt: { operationId: 'same' }, marker: n }],
          identityConfirmations: [{ marker: n }],
        },
      },
    });
  const write = (id: string, raw: string) => writeIntakeFixtureEnvelope(db, id, JSON.parse(raw));
  const insert = (id: string, n: number, kind = 'intake_original') => {
    if (kind === 'intake_original') return registerRawIntakeFixture(db, id, body(n));
    transaction(db, () =>
      db
        .prepare(
          'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
        )
        .run(id, id + '.txt', 'a'.repeat(64), 0, kind, body(n)),
    );
  };
  return { db, body, insert, write, authority };
}
test('cached lookup invalidation coalesces source UPSERTs and preserves rename and rollback boundaries', (t) => {
  const { db, body, insert } = fixture(t);
  insert('first', 3);
  insert('other', 100, 'derived');
  assert.equal(maximumReportDiscoveryOrder(db), 3);
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 3 }, { marker: 100 }]);
  const dirty = () =>
    db
      .prepare('SELECT source_id FROM temp.__intake_lookup_dirty ORDER BY source_id')
      .all()
      .map((row) => String(row.source_id));
  const upsert = db.prepare(`
    INSERT INTO source_files(id,path,sha256,bytes,kind,details_json)
    SELECT id,path,sha256,bytes,kind,details_json FROM source_files WHERE id=?
    ON CONFLICT(id) DO UPDATE SET id=?,details_json=?`);

  // The lookup cache has installed its TEMP triggers before this real UPSERT.
  // Its conflict policy must not turn repeated OLD/NEW dirty keys into errors.
  transaction(db, () => {
    upsert.run('other', 'other', body(200));
    upsert.run('other', 'other', body(201));
    assert.deepEqual(dirty(), ['other']);
  });
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 3 }, { marker: 201 }]);
  assert.deepEqual(dirty(), []);

  assert.throws(
    () =>
      transaction(db, () => {
        upsert.run('other', 'renamed', body(300));
        upsert.run('renamed', 'renamed', body(301));
        assert.deepEqual(dirty(), ['other', 'renamed']);
        assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 3 }, { marker: 301 }]);
        assert.equal(maximumReportDiscoveryOrder(db), 3);
        throw Error('fictional source UPSERT rollback');
      }),
    /fictional source UPSERT rollback/,
  );
  assert.deepEqual(dirty(), []);
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 3 }, { marker: 201 }]);
  assert.equal(db.prepare('SELECT id FROM source_files WHERE id=?').get('renamed'), undefined);

  transaction(db, () => {
    db.prepare('DELETE FROM source_files WHERE id=?').run('other');
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run('other', 'other.txt', 'a'.repeat(64), 0, 'derived', body(400));
    assert.deepEqual(dirty(), ['other']);
  });
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 3 }, { marker: 400 }]);
});
test('raw writes, reordered contributions, kind and ID changes preserve scoped lookup ordering', (t) => {
  const { db, body, insert, write } = fixture(t);
  insert('first', 3);
  insert('second', 9);
  insert('other', 100, 'derived');
  assert.equal(maximumReportDiscoveryOrder(db), 9);
  assert.equal((retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker, 3);
  assert.deepEqual(intakeIdentityConfirmations(db), [
    { marker: 3 },
    { marker: 9 },
    { marker: 100 },
  ]);
  transaction(db, () => {
    write('first', body(12));
    assert.equal(maximumReportDiscoveryOrder(db), 12);
    db.prepare('UPDATE source_files SET id=? WHERE id=?').run('renamed', 'other');
    assert.equal(maximumReportDiscoveryOrder(db), 12);
    assert.equal(
      (retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker,
      12,
    );
  });
  transaction(db, () => db.prepare('DELETE FROM source_files WHERE id=?').run('second'));
  assert.equal(maximumReportDiscoveryOrder(db), 12);
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 12 }, { marker: 100 }]);
});

for (const mode of ['ordinary', 'lost-cold-notification', 'late-source-event'] as const)
  test(`cold lookup replay closes input overflow without losing original answers: ${mode}`, (t) => {
    const { db, insert, write, body } = fixture(t);
    insert('first', 7);
    insert('deleted', 99);
    assert.equal(maximumReportDiscoveryOrder(db), 99);
    transaction(db, () => {
      const metadata = db.prepare('INSERT INTO main.app_meta(key,value) VALUES(?,?)');
      for (let index = 0; index < 101; index++)
        metadata.run(`fictional-unrelated-input-${index}`, 'fictional');
      write('first', body(14));
      db.prepare('DELETE FROM main.source_files WHERE id=?').run('deleted');
      insert('added', 22);
      for (let index = 0; index < 65; index++)
        db.prepare(
          'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
        ).run(
          `fictional-derived-${index}`,
          `fictional-derived-${index}.txt`,
          'a'.repeat(64),
          0,
          'derived',
          '{}',
        );
    });
    db.exec('DELETE FROM temp.__intake_lookup_dirty');
    clearIntakeLookupCache(db);
    const exec = DatabaseSync.prototype.exec;
    let injected = false;
    if (mode !== 'ordinary')
      DatabaseSync.prototype.exec = function (sql: string) {
        if (
          this === db &&
          !injected &&
          mode === 'lost-cold-notification' &&
          sql === 'SAVEPOINT __intake_lookup_reconcile'
        ) {
          injected = true;
          exec.call(db, "DELETE FROM temp.__intake_lookup_dirty WHERE source_id='first'");
        }
        if (
          this === db &&
          !injected &&
          mode === 'late-source-event' &&
          sql === 'RELEASE __intake_lookup_reconcile'
        ) {
          injected = true;
          db.prepare('UPDATE main.source_files SET path=? WHERE id=?').run(
            'fictional-late.txt',
            'first',
          );
        }
        return exec.call(this, sql);
      };
    try {
      if (mode === 'late-source-event') {
        assert.throws(() => prepareIntakeLookupProjection(db), /witness is unavailable/);
        assert.equal(injected, true);
      } else {
        prepareIntakeLookupProjection(db);
        if (mode === 'lost-cold-notification') assert.equal(injected, true);
        assert.equal(maximumReportDiscoveryOrder(db), 22);
        assert.deepEqual(retainedReportAcceptance(db, 'same'), {
          receipt: { operationId: 'same' },
          marker: 14,
        });
        assert.equal(retainedReportAcceptance(db, 'fictional-missing-operation'), null);
        assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 14 }, { marker: 22 }]);
        assert.equal(
          db
            .prepare('SELECT 1 FROM main.__record_intake_lookup_sources WHERE source_id=?')
            .get('deleted'),
          undefined,
        );
        assert.equal(
          db.prepare('SELECT COUNT(*) n FROM main.__record_intake_lookup_sources').get()!.n,
          67,
        );
      }
    } finally {
      DatabaseSync.prototype.exec = exec;
    }
  });

test('a paused identity reader cannot borrow a later completed reconciliation', (t) => {
  const { db, body, insert } = fixture(t);
  insert('first', 3);
  insert('other', 100, 'derived');
  const previous = iterateIntakeIdentityReferences(db);
  assert.equal(previous.next().done, false);
  assert.equal(maximumReportDiscoveryOrder(db), 3);
  db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(body(200), 'other');
  assert.equal(maximumReportDiscoveryOrder(db), 3);
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 3 }, { marker: 200 }]);
  assert.throws(() => previous.next(), /answer witness changed/);
});

test('a paused identity reader refuses a newly introduced TEMP source shadow', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 3);
  insert('other', 100, 'derived');
  const previous = iterateIntakeIdentityReferences(db);
  assert.equal(previous.next().done, false);
  db.exec('CREATE TEMP TABLE source_files AS SELECT * FROM main.source_files');
  assert.throws(() => previous.next(), /answer witness changed/);
  db.exec('DROP TABLE temp.source_files');
});
test('rollback restores allocation and freshness even when first build occurs inside transaction', (t) => {
  const { db, body, insert, write } = fixture(t);
  insert('first', 2);
  assert.throws(
    () =>
      transaction(db, () => {
        assert.equal(maximumReportDiscoveryOrder(db), 2);
        write('first', body(77));
        assert.equal(maximumReportDiscoveryOrder(db), 77);
        throw Error('fictional rollback');
      }),
    /fictional rollback/,
  );
  assert.equal(maximumReportDiscoveryOrder(db), 2);
  assert.equal((retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker, 2);
});
test('schema/index loss and cold payload corruption rebuild without persistent triggers or authority changes', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 5);
  maximumReportDiscoveryOrder(db);
  const original = db.prepare('SELECT details_json FROM source_files').get()!.details_json;
  db.exec(
    'DROP INDEX __record_intake_lookup_discovery; DROP INDEX __record_intake_lookup_operation',
  );
  const reads = intakeLookupCounters(db).authorityReads;
  assert.equal(maximumReportDiscoveryOrder(db), 5);
  assert.equal(intakeLookupCounters(db).authorityReads, reads);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name IN ('__record_intake_lookup_discovery','__record_intake_lookup_operation')",
      )
      .get()!.n,
    2,
  );
  db.exec("UPDATE __record_intake_lookup_payloads SET payload='{}'");
  clearIntakeLookupCache(db);
  assert.equal((retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker, 5);
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '__record_intake_lookup_*'",
    )
    .all();
  for (const row of names) db.exec(`DROP TABLE "${String(row.name)}"`);
  transaction(db, () => db.prepare('UPDATE source_files SET path=?').run('fictional-rebound.txt'));
  assert.equal(maximumReportDiscoveryOrder(db), 5);
  assert.equal(db.prepare('SELECT details_json FROM source_files').get()!.details_json, original);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE '%intake_lookup%'",
      )
      .get()!.n,
    0,
  );
});
test('warm legacy lookup refuses a preprepared disposable projection forgery', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 5);
  prepareIntakeLookupProjection(db);
  const forge = db.prepare('UPDATE __record_intake_lookup_groups SET discovery_order=999');
  assert.equal(maximumReportDiscoveryOrder(db), 5);
  const before = intakeLookupCounters(db).authorityReads;
  assert.equal(maximumReportDiscoveryOrder(db), 5);
  assert.equal(intakeLookupCounters(db).authorityReads, before);
  forge.run();
  assert.throws(() => maximumReportDiscoveryOrder(db), /disposable projection mutation/);
  clearIntakeLookupCache(db);
  assert.equal(maximumReportDiscoveryOrder(db), 5);
});
test('erasing a changed source dirty marker cannot preserve a stale projection seal', (t) => {
  const { db, body, insert } = fixture(t);
  insert('other', 100, 'derived');
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 100 }]);
  transaction(db, () => {
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(body(200), 'other');
    db.prepare('DELETE FROM temp.__intake_lookup_dirty WHERE source_id=?').run('other');
  });
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 200 }]);
});
test('erasing an accepted head dirty marker cannot preserve a stale projection seal', (t) => {
  const { db, body, insert, write } = fixture(t);
  insert('first', 5);
  assert.equal(maximumReportDiscoveryOrder(db), 5);
  transaction(db, () => {
    write('first', body(6));
    db.prepare("DELETE FROM temp.__intake_lookup_dirty WHERE source_id='first'").run();
  });
  assert.equal(maximumReportDiscoveryOrder(db), 6);
});
test('source change during the final schema read cannot seal a stale projection', (t) => {
  const { db, body, insert } = fixture(t);
  insert('first', 5);
  insert('other', 100, 'derived');
  let fired = false;
  const stop = observeManagedDatabaseAuthorization(
    db,
    (action, name, detail, database) => {
      if (
        fired ||
        action !== constants.SQLITE_READ ||
        name !== 'sqlite_master' ||
        detail !== 'sql' ||
        database !== 'main'
      )
        return;
      fired = true;
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(body(200), 'other');
      db.prepare("DELETE FROM temp.__intake_lookup_dirty WHERE source_id='other'").run();
    },
    () => {},
  );
  try {
    assert.throws(() => maximumReportDiscoveryOrder(db), /projection witness is unavailable/);
    assert.equal(fired, true);
  } finally {
    stop?.();
  }
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 5 }, { marker: 200 }]);
});
test('source change during witness setup cannot be cleared without reconciliation', (t) => {
  const { db, body, insert } = fixture(t);
  insert('first', 5);
  insert('other', 100, 'derived');
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 5 }, { marker: 100 }]);
  clearIntakeLookupCache(db);
  let fired = false;
  const stop = observeManagedDatabaseAuthorization(
    db,
    (action, name, detail, database) => {
      if (
        fired ||
        action !== constants.SQLITE_READ ||
        name !== 'sqlite_temp_master' ||
        detail !== 'sql' ||
        database !== 'temp'
      )
        return;
      fired = true;
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(body(200), 'other');
      db.prepare("DELETE FROM temp.__intake_lookup_dirty WHERE source_id='other'").run();
    },
    () => {},
  );
  try {
    ensureIntakeProjectionWitness(db);
    assert.equal(fired, true);
    assert.throws(
      () => sealIntakeProjectionWitness(db, projectionWitnessRevision(db)),
      /projection witness is unavailable/,
    );
  } finally {
    stop?.();
  }
  clearIntakeLookupCache(db);
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 5 }, { marker: 200 }]);
});
test('accepted head attempt during the final schema read cannot be erased by TEMP bookkeeping', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 5);
  assert.equal(maximumReportDiscoveryOrder(db), 5);
  const key = String(
    db
      .prepare("SELECT authority_key FROM __record_intake_lookup_sources WHERE source_id='first'")
      .get()!.authority_key,
  );
  clearIntakeLookupCache(db);
  let fired = false;
  const stop = observeManagedDatabaseAuthorization(
    db,
    (action, name, detail, database) => {
      if (
        fired ||
        action !== constants.SQLITE_READ ||
        name !== 'sqlite_master' ||
        detail !== 'sql' ||
        database !== 'main'
      )
        return;
      fired = true;
      db.prepare('UPDATE app_meta SET value=value WHERE key=?').run(key);
      db.prepare("DELETE FROM temp.__intake_lookup_dirty WHERE source_id='first'").run();
    },
    () => {},
  );
  try {
    assert.throws(() => maximumReportDiscoveryOrder(db), /projection witness is unavailable/);
    assert.equal(fired, true);
  } finally {
    stop?.();
  }
  assert.equal(maximumReportDiscoveryOrder(db), 5);
});
test('restored schema settings during the final schema read cannot authorize a seal', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 5);
  let fired = false;
  const stop = observeManagedDatabaseAuthorization(
    db,
    (action, name, detail, database) => {
      if (
        fired ||
        action !== constants.SQLITE_READ ||
        name !== 'sqlite_master' ||
        detail !== 'sql' ||
        database !== 'main'
      )
        return;
      fired = true;
      const before = Number(db.prepare('PRAGMA temp.schema_version').get()!.schema_version);
      db.exec(`PRAGMA temp.schema_version=${before + 1}; PRAGMA temp.schema_version=${before}`);
    },
    () => {},
  );
  try {
    assert.throws(() => maximumReportDiscoveryOrder(db), /projection witness is unavailable/);
    assert.equal(fired, true);
  } finally {
    stop?.();
  }
  assert.equal(maximumReportDiscoveryOrder(db), 5);
});
test('foreign projection mutation during the final schema read cannot authorize a seal', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 5);
  let fired = false;
  const stop = observeManagedDatabaseAuthorization(
    db,
    (action, name, detail, database) => {
      if (
        fired ||
        action !== constants.SQLITE_READ ||
        name !== 'sqlite_master' ||
        detail !== 'sql' ||
        database !== 'main'
      )
        return;
      fired = true;
      db.exec('UPDATE __record_intake_lookup_groups SET discovery_order=999');
    },
    () => {},
  );
  try {
    assert.throws(() => maximumReportDiscoveryOrder(db), /projection witness is unavailable/);
    assert.equal(fired, true);
  } finally {
    stop?.();
  }
  clearIntakeLookupCache(db);
  assert.equal(maximumReportDiscoveryOrder(db), 5);
});
test('maximum answer read refuses a foreign projection write before returning it', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 5);
  assert.equal(maximumReportDiscoveryOrder(db), 5);
  let fired = false;
  const stop = observeManagedDatabaseAuthorization(
    db,
    (action, name, detail, database) => {
      if (
        fired ||
        action !== constants.SQLITE_READ ||
        name !== '__record_intake_lookup_groups' ||
        detail !== 'discovery_order' ||
        database !== 'main'
      )
        return;
      fired = true;
      db.prepare('UPDATE __record_intake_lookup_groups SET discovery_order=999').run();
    },
    () => {},
  );
  try {
    assert.throws(() => maximumReportDiscoveryOrder(db), /projection answer witness changed/);
    assert.equal(fired, true);
  } finally {
    stop?.();
  }
  clearIntakeLookupCache(db);
  assert.equal(maximumReportDiscoveryOrder(db), 5);
});
test('maximum answer read refuses a restored TEMP schema attempt', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 5);
  assert.equal(maximumReportDiscoveryOrder(db), 5);
  let fired = false;
  const stop = observeManagedDatabaseAuthorization(
    db,
    (action, name, detail, database) => {
      if (
        fired ||
        action !== constants.SQLITE_READ ||
        name !== '__record_intake_lookup_groups' ||
        detail !== 'discovery_order' ||
        database !== 'main'
      )
        return;
      fired = true;
      const before = Number(db.prepare('PRAGMA temp.schema_version').get()!.schema_version);
      db.exec(`PRAGMA temp.schema_version=${before + 1}; PRAGMA temp.schema_version=${before}`);
    },
    () => {},
  );
  try {
    assert.throws(() => maximumReportDiscoveryOrder(db), /projection answer witness changed/);
    assert.equal(fired, true);
  } finally {
    stop?.();
  }
  clearIntakeLookupCache(db);
  assert.equal(maximumReportDiscoveryOrder(db), 5);
});
test('receipt answer read refuses an altered payload before returning it', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 5);
  assert.equal((retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker, 5);
  let fired = false;
  const stop = observeManagedDatabaseAuthorization(
    db,
    (action, name, detail, database) => {
      if (
        fired ||
        action !== constants.SQLITE_READ ||
        name !== '__record_intake_lookup_payloads' ||
        detail !== 'payload' ||
        database !== 'main'
      )
        return;
      fired = true;
      db.prepare('UPDATE __record_intake_lookup_payloads SET payload=?').run(
        JSON.stringify({ marker: 999 }),
      );
    },
    () => {},
  );
  try {
    assert.throws(() => retainedReportAcceptance(db, 'same'), /projection answer witness changed/);
    assert.equal(fired, true);
  } finally {
    stop?.();
  }
  clearIntakeLookupCache(db);
  assert.equal((retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker, 5);
});
test('receipt answer read refuses erased accepted-head bookkeeping', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 5);
  assert.equal((retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker, 5);
  const key = String(
    db
      .prepare("SELECT authority_key FROM __record_intake_lookup_sources WHERE source_id='first'")
      .get()!.authority_key,
  );
  let fired = false;
  const stop = observeManagedDatabaseAuthorization(
    db,
    (action, name, detail, database) => {
      if (
        fired ||
        action !== constants.SQLITE_READ ||
        name !== '__record_intake_lookup_acceptances' ||
        detail !== 'operation_id' ||
        database !== 'main'
      )
        return;
      fired = true;
      db.prepare('UPDATE app_meta SET value=value WHERE key=?').run(key);
      db.prepare("DELETE FROM temp.__intake_lookup_dirty WHERE source_id='first'").run();
    },
    () => {},
  );
  try {
    assert.throws(() => retainedReportAcceptance(db, 'same'), /projection answer witness changed/);
    assert.equal(fired, true);
  } finally {
    stop?.();
  }
  clearIntakeLookupCache(db);
  assert.equal((retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker, 5);
});
test('missing receipt answer read still closes its projection witness', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 5);
  assert.equal(retainedReportAcceptance(db, 'missing'), null);
  let fired = false;
  const stop = observeManagedDatabaseAuthorization(
    db,
    (action, name, detail, database) => {
      if (
        fired ||
        action !== constants.SQLITE_READ ||
        name !== '__record_intake_lookup_acceptances' ||
        detail !== 'operation_id' ||
        database !== 'main'
      )
        return;
      fired = true;
      db.prepare('UPDATE __record_intake_lookup_groups SET discovery_order=999').run();
    },
    () => {},
  );
  try {
    assert.throws(
      () => retainedReportAcceptance(db, 'missing'),
      /projection answer witness changed/,
    );
    assert.equal(fired, true);
  } finally {
    stop?.();
  }
  clearIntakeLookupCache(db);
  assert.equal(retainedReportAcceptance(db, 'missing'), null);
});
test('identity answer read refuses erased source bookkeeping before yielding', (t) => {
  const { db, body, insert } = fixture(t);
  insert('first', 5);
  insert('other', 100, 'derived');
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 5 }, { marker: 100 }]);
  let fired = false;
  const stop = observeManagedDatabaseAuthorization(
    db,
    (action, name, detail, database) => {
      if (
        fired ||
        action !== constants.SQLITE_READ ||
        name !== '__record_intake_lookup_payloads' ||
        detail !== 'payload' ||
        database !== 'main'
      )
        return;
      fired = true;
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(body(200), 'other');
      db.prepare("DELETE FROM temp.__intake_lookup_dirty WHERE source_id='other'").run();
    },
    () => {},
  );
  try {
    assert.throws(() => intakeIdentityConfirmations(db), /projection answer witness changed/);
    assert.equal(fired, true);
  } finally {
    stop?.();
  }
  clearIntakeLookupCache(db);
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 5 }, { marker: 200 }]);
});
test('empty identity traversal still closes its source query witness', (t) => {
  const { db } = fixture(t);
  registerRawIntakeFixture(db, 'first', JSON.stringify({ intake: { workflow: {} } }));
  assert.deepEqual(intakeIdentityConfirmations(db), []);
  let fired = false;
  const stop = observeManagedDatabaseAuthorization(
    db,
    (action, name, detail, database) => {
      if (
        fired ||
        action !== constants.SQLITE_READ ||
        name !== 'source_files' ||
        detail !== 'id' ||
        database !== 'main'
      )
        return;
      fired = true;
      db.prepare('UPDATE __record_intake_lookup_groups SET discovery_order=999').run();
    },
    () => {},
  );
  try {
    assert.throws(() => intakeIdentityConfirmations(db), /projection answer witness changed/);
    assert.equal(fired, true);
  } finally {
    stop?.();
  }
  clearIntakeLookupCache(db);
  assert.deepEqual(intakeIdentityConfirmations(db), []);
});
test('nested projection side effects cannot borrow an owned reconciliation ticket', (t) => {
  const { db, body, insert, write } = fixture(t);
  insert('first', 5);
  assert.equal(maximumReportDiscoveryOrder(db), 5);
  db.exec(`CREATE TEMP TRIGGER fictional_nested_projection AFTER UPDATE ON main.__record_intake_lookup_groups
    BEGIN UPDATE __record_intake_lookup_payloads SET payload='{}'; END`);
  write('first', body(6));
  assert.throws(() => maximumReportDiscoveryOrder(db), /owned write diverged/);
  db.exec('DROP TRIGGER temp.fictional_nested_projection');
  assert.equal(maximumReportDiscoveryOrder(db), 6);
});
test('identity iteration refuses a forged disposable successor before returning a receipt', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 5);
  assert.equal(maximumReportDiscoveryOrder(db), 5);
  db.prepare('UPDATE __record_intake_lookup_identities SET next=999 WHERE source_id=?').run(
    'first',
  );
  assert.throws(() => intakeIdentityConfirmations(db), /identity occurrence chain/);
  clearIntakeLookupCache(db);
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 5 }]);
});
test('invalid non-original JSON is skipped while malformed original contribution state remains unavailable', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 4);
  insert('invalid', 90, 'derived');
  db.exec('PRAGMA ignore_check_constraints=ON');
  transaction(db, () =>
    db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run('{', 'invalid'),
  );
  db.exec('PRAGMA ignore_check_constraints=OFF');
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 4 }]);
  assert.throws(
    () =>
      transaction(db, () => {
        db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
          JSON.stringify({ intake: { workflow: { reportGroups: { bad: true } } } }),
          'first',
        );
        maximumReportDiscoveryOrder(db);
      }),
    /authority|unsupported|missing/i,
  );
  assert.equal(maximumReportDiscoveryOrder(db), 4);
});

test('cold stale projection reconciled inside rollback remains cold afterward', (t) => {
  const { db, body, insert, write } = fixture(t);
  insert('first', 2);
  maximumReportDiscoveryOrder(db);
  // Simulate a later connection writing while lookup tracking is absent.
  db.exec('DROP TRIGGER temp.__intake_lookup_update');
  write('first', body(44));
  clearIntakeLookupCache(db);
  assert.throws(
    () =>
      transaction(db, () => {
        assert.equal(maximumReportDiscoveryOrder(db), 44);
        throw Error('rollback cold lookup');
      }),
    /rollback cold lookup/,
  );
  assert.equal(maximumReportDiscoveryOrder(db), 44);
  assert.equal((retainedReportAcceptance(db, 'same') as unknown as { marker: number }).marker, 44);
});

test('early insert, reorder, duplicate and removal update references without rewriting retained payload bytes', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 1);
  maximumReportDiscoveryOrder(db);
  const original = db.prepare('SELECT * FROM __record_intake_lookup_payloads ORDER BY hash').all();
  db.exec(
    'CREATE TEMP TABLE payload_updates(n); CREATE TEMP TRIGGER count_payload_updates AFTER UPDATE ON main.__record_intake_lookup_payloads BEGIN INSERT INTO payload_updates VALUES(1); END;',
  );
  const a = { receipt: { operationId: 'same' }, marker: 1 },
    b = { receipt: { operationId: 'same' }, marker: 2 };
  const write = (values: unknown[]) =>
    writeIntakeFixtureEnvelope(db, 'first', {
      intake: { workflow: { reportAcceptances: values, identityConfirmations: values } },
    });
  write([b, a, a]);
  assert.deepEqual(retainedReportAcceptance(db, 'same'), b);
  write([a, b, a]);
  assert.deepEqual(retainedReportAcceptance(db, 'same'), a);
  write([a, a]);
  assert.deepEqual(intakeIdentityConfirmations(db), [a, a]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payload_updates').get()!.n, 0);
  for (const row of original.filter((row) => String(row.payload).includes('receipt')))
    assert.deepEqual(
      db.prepare('SELECT * FROM __record_intake_lookup_payloads WHERE hash=?').get(row.hash!),
      row,
    );
  db.exec("UPDATE __record_intake_lookup_acceptances SET operation_id='wrong'");
  clearIntakeLookupCache(db);
  assert.deepEqual(retainedReportAcceptance(db, 'same'), a);
  assert.equal(retainedReportAcceptance(db, 'wrong'), null);
});

test('actual connection close and reopen reads selected intake head rather than stale lookup contribution', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-lookup-reopen-')),
    path = join(root, 'cache.sqlite');
  let db = openDatabase(path, 'fictional-profile');
  const authority = memoryRecordAuthority(db);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  registerRawIntakeFixture(
    db,
    'one',
    JSON.stringify({ intake: { workflow: { reportGroups: [{ discoveryOrder: 5 }] } } }),
  );
  assert.equal(maximumReportDiscoveryOrder(db), 5);
  db.close();
  db = openDatabase(path, 'fictional-profile');
  authority.attach(db);
  writeIntakeFixtureEnvelope(db, 'one', {
    intake: { workflow: { reportGroups: [{ discoveryOrder: 88 }] } },
  });
  assert.equal(maximumReportDiscoveryOrder(db), 88);
  assert.equal(intakeLookupCounters(db).builds, 1);
});

test('source ID rebinding refuses cross-source authority and rollback retains shared payload bytes', (t) => {
  const { db, insert } = fixture(t);
  insert('a', 3);
  maximumReportDiscoveryOrder(db);
  const original = db.prepare('SELECT * FROM __record_intake_lookup_payloads ORDER BY hash').all();
  assert.throws(
    () =>
      transaction(db, () => {
        db.prepare('UPDATE source_files SET id=? WHERE id=?').run('z', 'a');
        maximumReportDiscoveryOrder(db);
      }),
    /authority|missing|source|intake/i,
  );
  assert.equal(maximumReportDiscoveryOrder(db), 3);
  assert.deepEqual(
    db.prepare('SELECT * FROM __record_intake_lookup_payloads ORDER BY hash').all(),
    original,
  );
});

test('selected head corruption refuses warm and cold lookups without erasing retained receipts', (t) => {
  const { db, insert, authority } = fixture(t);
  insert('a', 1);
  insert('z', 2);
  maximumReportDiscoveryOrder(db);
  const keys = db
    .prepare("SELECT key,value FROM app_meta WHERE key GLOB 'intake_state_v1:*:head' ORDER BY key")
    .all();
  assert.equal(keys.length, 2);
  const selected = keys[1]!;
  for (const clear of [false, true]) {
    assert.throws(
      () =>
        transaction(db, () => {
          db.prepare('UPDATE app_meta SET value=? WHERE key=?').run(
            '{"format":"fictional-unsupported"}',
            selected.key!,
          );
          if (clear) clearIntakeLookupCache(db);
          maximumReportDiscoveryOrder(db);
        }),
      /intake|authority|schema|format/i,
    );
    assert.deepEqual(retainedReportAcceptance(db, 'same'), {
      receipt: { operationId: 'same' },
      marker: 1,
    });
    assert.equal(
      db.prepare('SELECT COUNT(*) n FROM __record_intake_lookup_acceptances').get()!.n,
      2,
    );
  }
  assert.ok(authority.objects.has('head'));
});

test('wrong projection affinity or singleton binding rebuilds from unchanged source evidence', (t) => {
  const { db, insert } = fixture(t);
  insert('one', 19);
  maximumReportDiscoveryOrder(db);
  const original = db.prepare('SELECT details_json FROM source_files').get()!.details_json;
  db.exec(
    'DROP TABLE __record_intake_lookup_groups; CREATE TABLE __record_intake_lookup_groups(source_id TEXT NOT NULL,ordinal INTEGER NOT NULL,discovery_order TEXT,PRIMARY KEY(source_id,ordinal));',
  );
  assert.equal(maximumReportDiscoveryOrder(db), 19);
  assert.equal(
    db.prepare('PRAGMA table_info(__record_intake_lookup_groups)').all()[2]!.type,
    'INTEGER',
  );
  db.exec(
    'PRAGMA ignore_check_constraints=ON; UPDATE __record_intake_lookup_state SET singleton=2; PRAGMA ignore_check_constraints=OFF',
  );
  clearIntakeLookupCache(db);
  assert.equal(maximumReportDiscoveryOrder(db), 19);
  assert.equal(
    db.prepare('SELECT singleton FROM __record_intake_lookup_state').get()!.singleton,
    1,
  );
  assert.equal(db.prepare('SELECT details_json FROM source_files').get()!.details_json, original);
});

test('raw SQL-first duplicate members, scalar identities and integer discovery conversion remain exact', (t) => {
  const { db } = fixture(t);
  registerRawIntakeFixture(
    db,
    'raw',
    `{"intake":{"workflow":{
    "reportGroups":[{"discoveryOrder":"009fictional","discoveryOrder":700},null,{}],
    "reportAcceptances":[{"receipt":{"operationId":"raw-first","operationId":"raw-last"},"marker":"first"},{"receipt":{"operationId":null}}],
    "identityConfirmations":[null,1,true,false,"fictional scalar","17",{"marker":"kept"}]
  }},"intake":{"workflow":{"reportGroups":[{"discoveryOrder":999}]}}}`,
  );
  assert.equal(maximumReportDiscoveryOrder(db), 9);
  assert.deepEqual(retainedReportAcceptance(db, 'raw-first'), {
    receipt: { operationId: 'raw-last' },
    marker: 'first',
  });
  assert.equal(retainedReportAcceptance(db, 'raw-last'), null);
  assert.deepEqual(intakeIdentityConfirmations(db), [null, 1, 1, 0, null, 17, { marker: 'kept' }]);
});

test('identity cycles, missing links, extra rows and missing payloads refuse warm and repair cold', (t) => {
  const { db, insert, write } = fixture(t);
  insert('first', 1);
  const identities = [{ marker: 1 }, { marker: 2 }, { marker: 1 }];
  write('first', JSON.stringify({ intake: { workflow: { identityConfirmations: identities } } }));
  assert.deepEqual(intakeIdentityConfirmations(db), identities);
  for (const corrupt of [
    'UPDATE __record_intake_lookup_identities SET next=id',
    'UPDATE __record_intake_lookup_identities SET next=999 WHERE next IS NOT NULL',
    'INSERT INTO __record_intake_lookup_identities SELECT source_id,999,NULL,hash FROM __record_intake_lookup_identities LIMIT 1',
    'DELETE FROM __record_intake_lookup_payloads',
  ]) {
    db.exec(corrupt);
    assert.throws(() => intakeIdentityConfirmations(db), /identity occurrence chain/);
    clearIntakeLookupCache(db);
    assert.deepEqual(intakeIdentityConfirmations(db), identities);
  }
});

test('deleting and reinserting a source updates cross-source acceptance and identity order', (t) => {
  const { db, insert } = fixture(t);
  insert('a', 1);
  insert('b', 2);
  assert.deepEqual(retainedReportAcceptance(db, 'same'), {
    receipt: { operationId: 'same' },
    marker: 1,
  });
  transaction(db, () => db.prepare('DELETE FROM source_files WHERE id=?').run('a'));
  insert('c', 3);
  assert.deepEqual(retainedReportAcceptance(db, 'same'), {
    receipt: { operationId: 'same' },
    marker: 2,
  });
  assert.deepEqual(intakeIdentityConfirmations(db), [{ marker: 2 }, { marker: 3 }]);
});

test('rolled-back payload memo is discarded before reconstruction and retry', (t) => {
  const { db, body, insert, write } = fixture(t);
  insert('first', 1);
  maximumReportDiscoveryOrder(db);
  const retainedRows = db
    .prepare('SELECT * FROM __record_intake_lookup_payloads ORDER BY hash')
    .all();
  const payloadBytes = (marker: number) =>
    Buffer.byteLength(JSON.stringify({ receipt: { operationId: 'same' }, marker })) +
    Buffer.byteLength(JSON.stringify({ marker }));
  const before = { ...intakeLookupCounters(db) };
  assert.throws(
    () =>
      transaction(db, () => {
        write('first', body(77));
        assert.equal(maximumReportDiscoveryOrder(db), 77);
        throw Error('fictional payload rollback');
      }),
    /fictional payload rollback/,
  );
  const failed = { ...intakeLookupCounters(db) };
  assert.equal(failed.hashedPayloadBytes - before.hashedPayloadBytes, payloadBytes(77));
  assert.equal(failed.payloadMemoClosed, failed.payloadMemoCreated);
  assert.deepEqual(
    db.prepare('SELECT * FROM __record_intake_lookup_payloads ORDER BY hash').all(),
    retainedRows,
  );
  assert.equal(maximumReportDiscoveryOrder(db), 1);
  const restored = { ...intakeLookupCounters(db) };
  assert.equal(
    restored.hashedPayloadBytes - failed.hashedPayloadBytes,
    payloadBytes(1),
    'cold restoration revalidates committed payloads',
  );
  write('first', body(77));
  assert.equal(maximumReportDiscoveryOrder(db), 77);
  const retried = { ...intakeLookupCounters(db) };
  assert.equal(
    retried.hashedPayloadBytes - restored.hashedPayloadBytes,
    payloadBytes(77),
    'an aborted new payload must be hashed again on retry',
  );
});

test('private payload memo prunes deleted evidence and closes on clear and actual connection close', (t) => {
  const { db, insert } = fixture(t);
  insert('first', 1);
  maximumReportDiscoveryOrder(db);
  const counters = intakeLookupCounters(db);
  assert.equal(counters.payloadMemoCreated, 1);
  assert.equal(counters.payloadMemoClosed, 0);
  const bytes = counters.hashedPayloadBytes;
  transaction(db, () => db.prepare('DELETE FROM source_files WHERE id=?').run('first'));
  assert.equal(maximumReportDiscoveryOrder(db), 0);
  insert('second', 1);
  assert.equal(maximumReportDiscoveryOrder(db), 1);
  assert.equal(counters.hashedPayloadBytes, 2 * bytes, 'deleted payloads leave the private memo');
  assert.equal(counters.payloadMemoCreated, 1, 'ordinary mutation reuses one private database');
  clearIntakeLookupCache(db);
  assert.equal(counters.payloadMemoClosed, 1);
  clearIntakeLookupCache(db);
  assert.equal(counters.payloadMemoClosed, 1, 'disposal is idempotent');
  assert.equal(maximumReportDiscoveryOrder(db), 1);
  const cold = intakeLookupCounters(db);
  assert.equal(cold.hashedPayloadBytes, bytes, 'clear requires actual cold payload verification');
  db.close();
  assert.equal(cold.payloadMemoClosed, cold.payloadMemoCreated);
});

test('forged public payload-to-hash rows never seed the private verification memo', (t) => {
  const { db, body, insert, write } = fixture(t);
  insert('first', 1);
  maximumReportDiscoveryOrder(db);
  const receipt = { receipt: { operationId: 'same' }, marker: 77 };
  const text = JSON.stringify(receipt);
  db.prepare('UPDATE __record_intake_lookup_payloads SET payload=? WHERE payload LIKE ?').run(
    text,
    '%receipt%',
  );
  clearIntakeLookupCache(db);
  write('first', body(77));
  assert.deepEqual(retainedReportAcceptance(db, 'same'), receipt);
  assert.equal(
    db.prepare('SELECT hash FROM __record_intake_lookup_payloads WHERE payload=?').get(text)!.hash,
    createHash('sha256').update(text).digest('hex'),
  );
  assert.equal(
    intakeLookupCounters(db).hashedPayloadBytes,
    Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify({ marker: 77 })),
    'cold authority text is hashed even when a public row claims to know its digest',
  );
});

test('database close observers preserve native results, unsubscription and independent cleanup', () => {
  for (const method of ['close', Symbol.dispose] as const) {
    const db = new DatabaseSync(':memory:');
    const events: string[] = [];
    const stop = observeDatabaseClose(db, () => events.push('removed'));
    stop();
    observeDatabaseClose(db, () => {
      assert.equal(db.isOpen, false);
      events.push('throwing');
      throw Error('fictional cleanup failure');
    });
    observeDatabaseClose(db, () => events.push('remaining'));
    assert.doesNotThrow(() => db[method]());
    assert.deepEqual(events, ['throwing', 'remaining']);
    assert.throws(() => db.close(), { code: 'ERR_INVALID_STATE' });
    assert.doesNotThrow(() => db[Symbol.dispose]());
    assert.deepEqual(events, ['throwing', 'remaining']);
  }
});
