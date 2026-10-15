import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, type Database } from '../database.ts';
import {
  attachRecordDurability,
  queryRecordHistory,
  readIndexedRecordVersion,
  rebuildRecordDatabase,
  type RecordStorage,
} from '../record-versions.ts';

const profileId = 'fictional-initial-metadata';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-metadata-history-'));
  const objects = new Map<string, Buffer>();
  const storage: RecordStorage = {
    read(name) {
      const value = objects.get(name);
      return value ? Buffer.from(value) : null;
    },
    writeImmutable(name, value) {
      assert.equal(objects.has(name), false);
      objects.set(name, Buffer.from(value));
    },
    publishHead(value) {
      objects.set('head', Buffer.from(value));
    },
  };
  const opened: Database[] = [];
  const open = (name: string) => {
    const db = openDatabase(join(root, name), profileId);
    opened.push(db);
    return db;
  };
  t.after(() => {
    for (const db of opened) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const db = open('current.sqlite');
  attachRecordDurability(db, { profileId, storage });
  return { root, objects, storage, db, open };
}

test('initial metadata retains exact history without redundant field rows', (t) => {
  for (const count of [4, 16]) {
    const { root, objects, storage, db, open } = fixture(t);
    const keys = Array.from({ length: count }, (_, index) => `fictional-meta-${index}`);
    const literalValue = '{"fictional":{"nested":"literal JSON text"}}';
    let fieldInsertRows = 0;
    const originalPrepare = DatabaseSync.prototype.prepare;
    const probe = t.mock.method(
      DatabaseSync.prototype,
      'prepare',
      function (this: DatabaseSync, sql: string) {
        const statement = originalPrepare.call(this, sql);
        if (this === db && sql.startsWith('INSERT INTO __record_fields VALUES')) {
          const run = statement.run;
          statement.run = (...args: unknown[]) => {
            for (let index = 0; index < args.length; index += 9)
              if (
                args[index + 2] === 'app_meta' &&
                keys.some((key) => args[index + 3] === JSON.stringify([key]))
              )
                fieldInsertRows++;
            return Reflect.apply(run, statement, args) as ReturnType<typeof run>;
          };
        }
        return statement;
      },
    );
    try {
      transaction(db, () => {
        const insert = db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)');
        for (const key of keys) insert.run(key, literalValue);
      });
    } finally {
      probe.mock.restore();
    }
    assert.equal(fieldInsertRows, 0, 'eligible creation executes no field-reference inserts');
    const selectedVersions = (database: Database) =>
      Number(
        database
          .prepare(
            `SELECT count(*) AS n FROM __record_versions WHERE entity='app_meta' AND record_id IN (${keys.map(() => '?').join(',')})`,
          )
          .get(...keys.map((key) => JSON.stringify([key])))?.n,
      );
    const selectedCurrent = (database: Database) =>
      Number(
        database
          .prepare(
            `SELECT count(*) AS n FROM __record_current WHERE entity='app_meta' AND record_id IN (${keys.map(() => '?').join(',')})`,
          )
          .get(...keys.map((key) => JSON.stringify([key])))?.n,
      );
    assert.equal(selectedVersions(db), count);
    assert.equal(selectedCurrent(db), count);
    const first = queryRecordHistory(db, {
      profileId,
      entity: 'app_meta',
      recordId: keys[0],
    });
    assert.equal(first.entries.length, 1);
    assert.deepEqual(
      first.entries[0]!.changes.map((change) => change.field),
      ['key', 'value'],
    );
    assert.deepEqual(first.entries[0]!.changes[1]!.before, { present: false });
    assert.deepEqual(first.entries[0]!.changes[1]!.after, {
      present: true,
      value: literalValue,
    });
    for (const field of ['key', 'value'])
      assert.equal(
        queryRecordHistory(db, { profileId, entity: 'app_meta', recordId: keys[0], field }).entries
          .length,
        1,
      );
    for (const field of ['unknown', 'value.fictional'])
      assert.equal(
        queryRecordHistory(db, { profileId, entity: 'app_meta', recordId: keys[0], field }).entries
          .length,
        0,
      );
    assert.deepEqual(
      readIndexedRecordVersion(
        db,
        profileId,
        'app_meta',
        JSON.stringify([keys[0]]),
        first.entries[0]!.versionId,
      )?.contents,
      { key: keys[0], value: literalValue },
    );
    const retained = new Map([...objects].map(([name, value]) => [name, Buffer.from(value)]));
    rebuildRecordDatabase(join(root, 'rebuilt.sqlite'), { profileId, storage });
    assert.deepEqual(objects, retained, 'rebuild does not rewrite accepted authority');
    const rebuilt = open('rebuilt.sqlite');
    attachRecordDurability(rebuilt, { profileId, storage });
    assert.equal(selectedVersions(rebuilt), count);
    assert.equal(selectedCurrent(rebuilt), count);
    assert.deepEqual(
      queryRecordHistory(rebuilt, {
        profileId,
        entity: 'app_meta',
        recordId: keys[0],
      }),
      first,
    );
    const selectedRows = (database: Database) =>
      Number(
        database
          .prepare(
            `SELECT count(*) AS n FROM __record_fields WHERE entity='app_meta' AND record_id IN (${keys.map(() => '?').join(',')})`,
          )
          .get(...keys.map((key) => JSON.stringify([key])))?.n,
      );
    assert.equal(selectedRows(db), 0, 'first metadata versions need no stored field references');
    assert.equal(selectedRows(rebuilt), 0, 'rebuild uses the same derived field representation');
  }
});

test('later metadata changes keep ordinary field rows and exact pagination', (t) => {
  const { db } = fixture(t);
  const key = 'fictional-changing-key';
  const history = (field?: string, beforeSequence?: number, limit?: number) =>
    queryRecordHistory(db, {
      profileId,
      entity: 'app_meta',
      recordId: key,
      field,
      beforeSequence,
      limit,
    });
  transaction(db, () => db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(key, 'one'));
  const initial = history().entries[0]!;
  assert.equal(
    Number(
      db
        .prepare('SELECT count(*) AS n FROM __record_fields WHERE version_id=?')
        .get(initial.versionId)?.n,
    ),
    0,
  );
  transaction(db, () => db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('one', key));
  const unchanged = history().entries[0]!;
  assert.equal(unchanged.previousVersion, initial.versionId);
  assert.deepEqual(unchanged.changes, [], 'the retained no-op version has no changed fields');
  transaction(db, () => db.prepare('UPDATE app_meta SET value=? WHERE key=?').run('two', key));
  const changed = history().entries[0]!;
  assert.deepEqual(
    changed.changes.map((change) => change.field),
    ['value'],
  );
  assert.deepEqual(changed.changes[0]?.before, { present: true, value: 'one' });
  assert.deepEqual(changed.changes[0]?.after, { present: true, value: 'two' });
  assert.equal(
    Number(
      db
        .prepare('SELECT count(*) AS n FROM __record_fields WHERE version_id=?')
        .get(changed.versionId)?.n,
    ),
    1,
  );
  transaction(db, () => db.prepare('DELETE FROM app_meta WHERE key=?').run(key));
  const removed = history().entries[0]!;
  assert.equal(removed.deleted, true);
  assert.deepEqual(
    removed.changes.map((change) => change.field),
    ['key', 'value'],
  );
  transaction(db, () =>
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(key, 'three'),
  );
  const reinserted = history().entries[0]!;
  assert.equal(reinserted.previousVersion, removed.versionId);
  assert.deepEqual(
    reinserted.changes.map((change) => change.field),
    ['key', 'value'],
  );
  assert.equal(
    Number(
      db
        .prepare('SELECT count(*) AS n FROM __record_fields WHERE version_id=?')
        .get(reinserted.versionId)?.n,
    ),
    2,
  );
  const page1 = history('value', undefined, 2);
  assert.deepEqual(
    page1.entries.map((entry) => entry.versionId),
    [reinserted.versionId, removed.versionId],
  );
  assert.equal(page1.nextSequence, removed.sequence);
  const page2 = history('value', page1.nextSequence!, 2);
  assert.deepEqual(
    page2.entries.map((entry) => entry.versionId),
    [changed.versionId, initial.versionId],
  );
  assert.equal(page2.nextSequence, null);
  assert.deepEqual(
    history('key').entries.map((entry) => entry.versionId),
    [reinserted.versionId, removed.versionId, initial.versionId],
  );
  assert.equal(history('value.anything').entries.length, 0);
  assert.equal(history('unknown').entries.length, 0);
  transaction(db, () =>
    db.prepare('UPDATE app_meta SET key=? WHERE key=?').run('fictional-renamed-key', key),
  );
  const oldKey = history().entries[0]!;
  const newKey = queryRecordHistory(db, {
    profileId,
    entity: 'app_meta',
    recordId: 'fictional-renamed-key',
  }).entries[0]!;
  assert.equal(oldKey.deleted, true);
  assert.equal(newKey.previousVersion, null);
  assert.deepEqual(
    newKey.changes.map((change) => change.field),
    ['key', 'value'],
  );
  assert.equal(
    Number(
      db
        .prepare('SELECT count(*) AS n FROM __record_fields WHERE version_id=?')
        .get(newKey.versionId)?.n,
    ),
    0,
  );
});

test('selected initial metadata refuses stray references and corrupt contents', (t) => {
  for (const fault of [
    'extra-field',
    'object-value',
    'metadata',
    'predecessor',
    'obsolete-projection',
  ] as const) {
    const { db, objects, storage, root, open } = fixture(t);
    const key = `fictional-${fault}`;
    transaction(db, () =>
      db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(key, 'literal'),
    );
    const initial = queryRecordHistory(db, { profileId, entity: 'app_meta', recordId: key })
      .entries[0]!;
    const archived = new Map([...objects].map(([name, value]) => [name, Buffer.from(value)]));
    if (fault === 'extra-field')
      db.prepare('INSERT INTO __record_fields VALUES(?,?,?,?,?,?,?,?,?)').run(
        initial.versionId,
        profileId,
        'app_meta',
        JSON.stringify([key]),
        'value',
        initial.sequence,
        null,
        0,
        1,
      );
    if (fault === 'object-value')
      db.prepare('UPDATE __record_versions SET contents_json=? WHERE version_id=?').run(
        JSON.stringify({ key, value: { nested: 'invalid for this scalar column' } }),
        initial.versionId,
      );
    if (fault === 'metadata')
      db.prepare(
        "UPDATE __record_versions SET metadata_json=json_set(metadata_json,'$.entity','other') WHERE version_id=?",
      ).run(initial.versionId);
    if (fault === 'predecessor')
      db.prepare('UPDATE __record_versions SET previous_version=? WHERE version_id=?').run(
        'fictional-missing-predecessor',
        initial.versionId,
      );
    if (fault === 'obsolete-projection') {
      db.prepare('UPDATE __record_state SET projection=2').run();
      assert.throws(() => attachRecordDurability(db, { profileId, storage }), /unsupported/);
      assert.deepEqual(objects, archived, 'incompatible cache refusal does not rewrite authority');
      rebuildRecordDatabase(join(root, 'rebuilt.sqlite'), { profileId, storage });
      const rebuilt = open('rebuilt.sqlite');
      attachRecordDurability(rebuilt, { profileId, storage });
      assert.equal(
        queryRecordHistory(rebuilt, { profileId, entity: 'app_meta', recordId: key }).entries
          .length,
        1,
      );
    } else {
      assert.throws(
        () =>
          queryRecordHistory(db, {
            profileId,
            entity: 'app_meta',
            recordId: key,
            field: fault === 'predecessor' ? undefined : 'value',
          }),
        /indexed/,
      );
      assert.deepEqual(
        objects,
        archived,
        'a corrupt derived cache never mutates accepted authority',
      );
    }
  }
});
