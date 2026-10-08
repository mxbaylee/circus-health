/** Counted record SQL regressions; the full HTTP/encrypted acceptance gate remains separate. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction, type Database } from '../database.ts';
import { rebuildRecordDatabase, queryRecordHistory } from '../record-versions.ts';
import { createRecordVersionWorkCounters, withRecordVersionWork } from '../record-version-work.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';

const snapshot = (db: Database) =>
  [
    'people',
    'source_files',
    '__record_versions',
    '__record_current',
    '__record_fields',
    '__record_transactions',
    '__record_state',
  ].map((table) => [
    table,
    db
      .prepare(`SELECT * FROM "${table}"`)
      .all()
      .map((row) => JSON.stringify(row))
      .sort(),
  ]);

for (const count of [4, 64])
  test(`replay prepares row SQL per table/transaction rather than per version: ${count} people`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-replay-sql-'));
    const profileId = 'fictional-replay-sql';
    const db = openDatabase(join(root, 'source.sqlite'), profileId);
    const opened = [db];
    t.after(() => {
      for (const connection of opened) if (connection.isOpen) connection.close();
      rmSync(root, { recursive: true, force: true });
    });
    const authority = memoryRecordAuthority(db);
    transaction(db, () => {
      const insert = db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)');
      for (let i = 0; i < count; i++) insert.run(`fictional-person-${i}`, `Fictional person ${i}`);
    });
    transaction(db, () => {
      const update = db.prepare('UPDATE people SET display_name=? WHERE id=?');
      for (let i = 0; i < count; i++)
        update.run(`Revised fictional person ${i}`, `fictional-person-${i}`);
    });
    transaction(db, () => db.prepare('DELETE FROM people WHERE id=?').run('fictional-person-0'));
    const expected = snapshot(db);
    const history = queryRecordHistory(db, {
      profileId,
      entity: 'people',
      recordId: 'fictional-person-0',
    });
    assert.deepEqual(
      history.entries.map((entry) => entry.deleted),
      [true, false, false],
    );
    const archiveHash = () => {
      const hash = createHash('sha256');
      for (const [name, bytes] of [...authority.objects].sort(([a], [b]) => a.localeCompare(b)))
        hash.update(name).update(bytes);
      return hash.digest('hex');
    };
    const originalArchive = archiveHash();
    // Two independent cold rebuilds from exactly the same accepted archive.
    // No cross-connection cache or successful first replay may authorize the second.
    for (let attempt = 0; attempt < 2; attempt++) {
      const prepared = { remove: 0, insert: 0 };
      const executed = { remove: 0, insert: 0 };
      const scratch = {
        ancestry: { inserts: 0, outsideTransaction: 0, connections: 0 },
        segments: { inserts: 0, outsideTransaction: 0, connections: 0 },
      };
      const scratchConnections: Array<{ db: DatabaseSync; path: string }> = [];
      const prepare = DatabaseSync.prototype.prepare;
      const probe = t.mock.method(
        DatabaseSync.prototype,
        'prepare',
        function (this: DatabaseSync, sql: string) {
          const statement = prepare.call(this, sql);
          const scratchKind =
            sql === 'INSERT INTO ancestry VALUES(?,?,?)'
              ? 'ancestry'
              : sql === 'INSERT INTO segments VALUES(?,?)'
                ? 'segments'
                : undefined;
          if (scratchKind) {
            const connection = this;
            const work = scratch[scratchKind];
            work.connections++;
            scratchConnections.push({ db: connection, path: connection.location()! });
            const run = statement.run;
            statement.run = (...args: unknown[]) => {
              work.inserts++;
              if (!connection.isTransaction) work.outsideTransaction++;
              return Reflect.apply(run, statement, args) as ReturnType<typeof run>;
            };
          }
          const kind =
            sql === 'DELETE FROM "people" WHERE "id"=?'
              ? 'remove'
              : sql.startsWith('INSERT INTO "people" (')
                ? 'insert'
                : undefined;
          if (kind) {
            prepared[kind]++;
            const run = statement.run;
            statement.run = (...args: unknown[]) => {
              executed[kind]++;
              return Reflect.apply(run, statement, args) as ReturnType<typeof run>;
            };
          }
          return statement;
        },
      );
      const work = createRecordVersionWorkCounters();
      const path = join(root, `rebuilt-${attempt}.sqlite`);
      try {
        withRecordVersionWork(work, () =>
          rebuildRecordDatabase(path, { profileId, storage: authority.storage }),
        );
      } finally {
        probe.mock.restore();
      }
      const measuredScratch = structuredClone(scratch);
      assert.ok(scratchConnections.length > 0, 'the real disk-backed ordering indexes were used');
      for (const connection of scratchConnections) {
        assert.equal(connection.db.isOpen, false, 'scratch never outlives its traversal');
        assert.equal(existsSync(connection.path), false, 'scratch is deleted after consumption');
      }
      const rebuilt = openDatabase(path, profileId);
      opened.push(rebuilt);
      authority.attach(rebuilt);
      assert.deepEqual(snapshot(rebuilt), expected, 'all current and historical rows remain exact');
      assert.deepEqual(
        queryRecordHistory(rebuilt, {
          profileId,
          entity: 'people',
          recordId: 'fictional-person-0',
        }),
        history,
        'tombstones and predecessor/field history survive cold replay',
      );
      assert.equal(archiveHash(), originalArchive, 'replay never rewrites its accepted archive');
      assert.deepEqual(executed, { remove: 2 * count + 2, insert: 2 * count + 1 });
      assert.equal(
        work.reconstruction.versionValidations,
        2 * work.reconstruction.indexedVersionAttempts,
      );
      assert.equal(
        work.reconstruction.replayDeleteAttempts,
        work.reconstruction.indexedVersionAttempts,
      );
      t.diagnostic(
        JSON.stringify({
          count,
          attempt,
          prepared,
          executed,
          scratch: measuredScratch,
          work: work.reconstruction,
        }),
      );
      assert.equal(measuredScratch.ancestry.inserts, work.reconstruction.ancestryReferencesSpooled);
      assert.equal(measuredScratch.segments.inserts, work.reconstruction.segmentReferencesSpooled);
      for (const kind of ['ancestry', 'segments'] as const) {
        assert.ok(measuredScratch[kind].inserts > 0);
        assert.equal(
          measuredScratch[kind].outsideTransaction,
          0,
          kind + ': ordering-index inserts share one private transaction per traversal',
        );
      }
      assert.deepEqual(
        prepared,
        { remove: 4, insert: 3 },
        'one statement per touched table/transaction and replay phase',
      );
    }
  });

/** Count actual SQL preparation and execution, not a producer-reported estimate. */
function recordSqlProbe(t: TestContext) {
  const reads = new Map<string, { prepared: number; executed: number }>();
  const fields = { prepared: 0, calls: 0, rows: 0, largest: 0 };
  const prepare = DatabaseSync.prototype.prepare;
  const probe = t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      const name = /^SELECT \* FROM "(people|source_files)" WHERE "id"=\?$/.exec(sql)?.[1];
      if (name) {
        let counts = reads.get(name);
        if (!counts) reads.set(name, (counts = { prepared: 0, executed: 0 }));
        counts.prepared++;
        const get = statement.get;
        statement.get = (...args: unknown[]) => {
          counts.executed++;
          return Reflect.apply(get, statement, args) as ReturnType<typeof get>;
        };
      }
      if (sql.startsWith('INSERT INTO __record_fields VALUES')) {
        fields.prepared++;
        const run = statement.run;
        statement.run = (...args: unknown[]) => {
          const rows = (sql.match(/\?/g)?.length ?? 0) / 9;
          assert.ok(Number.isInteger(rows) && rows >= 1 && rows <= 32);
          assert.equal(args.length, rows * 9);
          fields.calls++;
          fields.rows += rows;
          fields.largest = Math.max(fields.largest, rows);
          return Reflect.apply(run, statement, args) as ReturnType<typeof run>;
        };
      }
      return statement;
    },
  );
  return { reads, fields, close: () => probe.mock.restore() };
}

for (const count of [4, 64])
  test(`publication reads fresh rows with per-table SQL and batches field indexes: ${count} people`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'fictional-publication-sql-'));
    const profileId = 'fictional-publication-sql';
    const db = openDatabase(join(root, 'source.sqlite'), profileId);
    const opened = [db];
    t.after(() => {
      for (const connection of opened) if (connection.isOpen) connection.close();
      rmSync(root, { recursive: true, force: true });
    });
    const authority = memoryRecordAuthority(db);
    const firstDetails = {
      kept: null,
      removed: 'first',
      fields: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`field-${i}`, i])),
    };
    const nextDetails = {
      kept: 'second',
      added: null,
      fields: Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`field-${i}`, i + 1])),
    };
    const samples: unknown[] = [];
    const probes: ReturnType<typeof recordSqlProbe>[] = [];
    const publish = (label: string, operation: () => void) => {
      const probe = recordSqlProbe(t);
      probes.push(probe);
      const work = createRecordVersionWorkCounters();
      const operationId = randomUUID();
      const receipt = { fixture: 'publication-sql', label, count };
      try {
        assert.deepEqual(
          withRecordVersionWork(work, () =>
            transaction(
              db,
              () => {
                operation();
                return receipt;
              },
              { operationId, fingerprint: label },
            ),
          ),
          receipt,
        );
      } finally {
        probe.close();
      }
      const indexed = db
        .prepare('SELECT commit_json FROM __record_transactions WHERE operation_id=?')
        .get(operationId)!;
      const records = JSON.parse(String(indexed.commit_json)).records as number;
      assert.equal(work.operation.indexedVersionAttempts, records);
      const rows = db
        .prepare(
          'SELECT count(*) n FROM __record_fields f JOIN __record_versions v USING(version_id) WHERE v.operation_id=?',
        )
        .get(operationId)!.n;
      assert.equal(probe.fields.rows, Number(rows), 'every field index row actually executes');
      assert.equal(
        probe.reads.get('people')?.executed,
        count,
        'fresh current-row SQL executes for every changed person',
      );
      assert.equal(
        probe.reads.get('source_files')?.executed,
        1,
        'mixed-table traversal reads its source too',
      );
      const beforeRetry = snapshot(db);
      const headBeforeRetry = Buffer.from(authority.objects.get('head')!);
      assert.deepEqual(
        transaction(
          db,
          () => {
            throw Error('an exact retry must not rerun its operation');
          },
          { operationId, fingerprint: label },
        ),
        receipt,
      );
      assert.deepEqual(snapshot(db), beforeRetry);
      assert.deepEqual(authority.objects.get('head'), headBeforeRetry);
      samples.push({
        label,
        reads: Object.fromEntries(probe.reads),
        fields: probe.fields,
        records,
      });
    };
    publish('insert', () => {
      const insert = db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)');
      for (let i = 0; i < count; i++) insert.run(`person-${i}`, `Fictional person ${i}`);
      db.prepare(
        'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
      ).run(
        'source',
        'fictional.txt',
        '0'.repeat(64),
        0,
        'source_capture',
        JSON.stringify(firstDetails),
      );
    });
    publish('update', () => {
      db.prepare(
        "UPDATE people SET display_name=display_name || ' revised' WHERE id LIKE 'person-%'",
      ).run();
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
        JSON.stringify(nextDetails),
        'source',
      );
    });
    publish('delete', () => {
      db.prepare("DELETE FROM people WHERE id LIKE 'person-%'").run();
      db.prepare("DELETE FROM source_files WHERE id='source'").run();
    });
    const history = queryRecordHistory(db, {
      profileId,
      entity: 'source_files',
      recordId: 'source',
    });
    assert.deepEqual(
      history.entries.map((entry) => entry.deleted),
      [true, false, false],
    );
    const changes = history.entries[1]!.changes;
    assert.deepEqual(
      changes.find((change) => change.field === 'details_json.removed'),
      {
        field: 'details_json.removed',
        before: { present: true, value: 'first' },
        after: { present: false },
      },
    );
    assert.deepEqual(
      changes.find((change) => change.field === 'details_json.added'),
      {
        field: 'details_json.added',
        before: { present: false },
        after: { present: true, value: null },
      },
    );
    assert.deepEqual(
      changes.find((change) => change.field === 'details_json.kept'),
      {
        field: 'details_json.kept',
        before: { present: true, value: null },
        after: { present: true, value: 'second' },
      },
    );
    const expected = snapshot(db);
    const originalArchive = new Map(
      [...authority.objects].map(([key, value]) => [key, Buffer.from(value)]),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const path = join(root, `rebuilt-${attempt}.sqlite`);
      const probe = recordSqlProbe(t);
      probes.push(probe);
      try {
        rebuildRecordDatabase(path, { profileId, storage: authority.storage });
      } finally {
        probe.close();
      }
      const rebuilt = openDatabase(path, profileId);
      opened.push(rebuilt);
      authority.attach(rebuilt);
      assert.deepEqual(
        snapshot(rebuilt),
        expected,
        'all full current/version/field/receipt rows survive a fresh reconstruction',
      );
      assert.deepEqual(
        queryRecordHistory(rebuilt, { profileId, entity: 'source_files', recordId: 'source' }),
        history,
      );
      assert.deepEqual(authority.objects, originalArchive);
      const rows = Number(rebuilt.prepare('SELECT count(*) n FROM __record_fields').get()!.n);
      assert.equal(probe.fields.rows, rows);
      samples.push({ label: `replay-${attempt}`, fields: probe.fields });
    }
    t.diagnostic(
      JSON.stringify({
        count,
        samples,
        scope: 'SQL calls and rows, not physical I/O or a full HTTP/identity gate',
      }),
    );
    for (const probe of probes) {
      for (const counts of probe.reads.values())
        assert.equal(
          counts.prepared,
          1,
          'one fresh read statement per touched table and collection traversal',
        );
      assert.ok(
        probe.fields.calls < probe.fields.rows,
        'field indexes use bounded multi-row calls, not one call per field',
      );
      assert.equal(
        probe.fields.largest,
        32,
        'large nested values cross the bounded field-row batch',
      );
    }
  });

test('field-index batch failure rolls back the entire publication and exact retry remains fresh', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-field-batch-refusal-'));
  const profileId = 'fictional-field-batch-refusal';
  const db = openDatabase(join(root, 'current.sqlite'), profileId);
  const opened = [db];
  t.after(() => {
    for (const connection of opened) if (connection.isOpen) connection.close();
    rmSync(root, { recursive: true, force: true });
  });
  const authority = memoryRecordAuthority(db);
  const before = snapshot(db);
  const acceptedHead = Buffer.from(authority.objects.get('head')!);
  const details = Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`field-${i}`, i]));
  const operation = { operationId: randomUUID(), fingerprint: 'fictional-index-batch-refusal' };
  const receipt = { created: 'fictional-source' };
  const write = () => {
    db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)').run('person', 'Fictional person');
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(
      'fictional-source',
      'fictional.txt',
      '0'.repeat(64),
      0,
      'source_capture',
      JSON.stringify(details),
    );
    return receipt;
  };
  const prepare = DatabaseSync.prototype.prepare;
  let interrupted = false;
  const probe = t.mock.method(
    DatabaseSync.prototype,
    'prepare',
    function (this: DatabaseSync, sql: string) {
      const statement = prepare.call(this, sql);
      if (this === db && sql.startsWith('INSERT INTO __record_fields VALUES')) {
        const run = statement.run;
        statement.run = (...args: unknown[]) => {
          const result = Reflect.apply(run, statement, args) as ReturnType<typeof run>;
          if (!interrupted && args[2] === 'source_files' && args.length === 32 * 9) {
            interrupted = true;
            throw Error('Fictional interruption after a real field batch');
          }
          return result;
        };
      }
      return statement;
    },
  );
  try {
    assert.throws(
      () => transaction(db, write, operation),
      /Fictional interruption after a real field batch/,
    );
  } finally {
    probe.mock.restore();
  }
  assert.equal(interrupted, true, 'the failure happens after actual indexed rows were inserted');
  assert.equal(db.isTransaction, false);
  assert.deepEqual(
    snapshot(db),
    before,
    'no partial rows, field history or replay receipt escapes',
  );
  assert.deepEqual(
    authority.objects.get('head'),
    acceptedHead,
    'failure before accepted publication cannot advance durable authority',
  );
  assert.deepEqual(
    transaction(db, write, operation),
    receipt,
    'the failed operation has no replay entry',
  );
  const expected = snapshot(db);
  assert.deepEqual(
    transaction(
      db,
      () => {
        throw Error('must replay');
      },
      operation,
    ),
    receipt,
  );
  assert.deepEqual(snapshot(db), expected);
  const path = join(root, 'rebuilt.sqlite');
  rebuildRecordDatabase(path, { profileId, storage: authority.storage });
  const rebuilt = openDatabase(path, profileId);
  opened.push(rebuilt);
  authority.attach(rebuilt);
  assert.deepEqual(
    snapshot(rebuilt),
    expected,
    'orphan objects from the failed publication are not selected',
  );
  assert.equal(
    queryRecordHistory(rebuilt, { profileId, entity: 'source_files', recordId: 'fictional-source' })
      .entries.length,
    1,
  );
});

test('empty field deltas retain distinct complete versions without borrowing a prior batch', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-empty-fields-'));
  const profileId = 'fictional-empty-fields';
  const db = openDatabase(join(root, 'current.sqlite'), profileId);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  memoryRecordAuthority(db);
  transaction(db, () =>
    db.prepare('INSERT INTO people(id,display_name) VALUES(?,?)').run('person', 'Fictional person'),
  );
  transaction(db, () =>
    db.prepare('UPDATE people SET display_name=display_name WHERE id=?').run('person'),
  );
  const history = queryRecordHistory(db, { profileId, entity: 'people', recordId: 'person' });
  assert.equal(history.entries.length, 2);
  assert.notEqual(history.entries[0]!.versionId, history.entries[1]!.versionId);
  assert.deepEqual(history.entries[0]!.changes, []);
  assert.deepEqual(history.entries[0]!.contents, history.entries[1]!.contents);
  assert.equal(
    db
      .prepare('SELECT count(*) n FROM __record_fields WHERE version_id=?')
      .get(history.entries[0]!.versionId)!.n,
    0,
  );
});
