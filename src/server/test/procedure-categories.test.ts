import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  openDatabase,
  databaseSchemaVersion,
  transaction,
  LATEST_SCHEMA_VERSION,
  type Database,
} from '../database.ts';
import {
  attachRecordDurability,
  queryRecordHistory,
  type RecordStorage,
} from '../record-versions.ts';
import { clinicalList } from '../queries.ts';
import { createApp } from '../index.ts';
import { hash } from '../assets.ts';
import { createBackup, restoreBackup } from '../recovery.ts';
const schema1 = readFileSync(new URL('../migrations/001-initial.sql', import.meta.url), 'utf8');
function temporary(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-procedure-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function seedBase(db: Database) {
  db.exec(
    "INSERT INTO providers VALUES('issuer','Source issuer'); INSERT INTO source_files(id,provider_id,path,sha256,bytes) VALUES('file','issuer','providers/fixture.json','x',1); INSERT INTO source_records(id,source_file_id,provider_id,raw_json) VALUES('raw','file','issuer','{\"original\":\"kept\"}');",
  );
}
function legacyDatabase(path: string, owner: string) {
  const db = new DatabaseSync(path);
  db.exec(schema1);
  db.prepare("INSERT INTO app_meta(key,value) VALUES('owner_profile_id',?)").run(owner);
  db.prepare("UPDATE app_meta SET value='37' WHERE key='revision'").run();
  seedBase(db);
  db.exec(
    "INSERT INTO procedures(id,source_record_id,provider_id,label,effective_at,status,extra_json) VALUES('existing','raw','issuer','Original procedure label','2016-07-12','completed','{\"sourceFields\":{\"performer\":\"not assumed from provider\"}}'); INSERT INTO notes(id,kind,status,title,content,created_at,updated_at,finished_at) VALUES('finished','historical','finished','Saved history','Unchanged words','2026-09-10 01:00:00','2026-09-10 01:00:00','2026-09-10 01:00:00');",
  );
  return db;
}
function requiredRow<T extends object>(value: unknown): T {
  assert.ok(value && typeof value === 'object');
  return value as T;
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

test('schema 1 upgrades both owners atomically without classifying records or changing evidence/frozen notes', (t) => {
  const root = temporary(t);
  for (const owner of ['cedar', 'cookie-dough']) {
    const path = resolve(root, owner + '.sqlite');
    let db = legacyDatabase(path, owner);
    const beforeProcedure = db.prepare('SELECT * FROM procedures').get(),
      beforeSource = db.prepare('SELECT * FROM source_records').get(),
      beforeNote = db.prepare('SELECT * FROM notes').get();
    db.close();
    db = openDatabase(path, owner);
    assert.equal(databaseSchemaVersion(db), LATEST_SCHEMA_VERSION);
    assert.deepEqual(
      db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((r) => r.version),
      [1, 2, 3, 4, 5, 6, 7],
    );
    const { category, ...afterProcedure } = requiredRow<
      Record<string, unknown> & { category: string }
    >(db.prepare('SELECT * FROM procedures').get());
    assert.equal(category, 'unspecified');
    assert.deepEqual({ ...beforeProcedure }, afterProcedure);
    assert.deepEqual(db.prepare('SELECT * FROM source_records').get(), beforeSource);
    const { text_formats_json, ...afterNote } = requiredRow<
      Record<string, unknown> & { text_formats_json: string }
    >(db.prepare('SELECT * FROM notes').get());
    assert.equal(text_formats_json, '{}');
    assert.deepEqual(afterNote, { ...beforeNote });
    assert.equal(
      db.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()?.value,
      owner,
    );
    assert.equal(db.prepare("SELECT value FROM app_meta WHERE key='revision'").get()?.value, '37');
    assert.throws(
      () => db.prepare("UPDATE procedures SET category='guessed diagnosis'").run(),
      /CHECK constraint failed/,
    );
    db.prepare("UPDATE procedures SET category='surgery' WHERE id='existing'").run();
    db.close();
    db = openDatabase(path, owner);
    assert.equal(db.prepare('SELECT category FROM procedures').get()?.category, 'surgery');
    assert.equal(
      db.prepare('SELECT count(*) n FROM schema_migrations').get()?.n,
      LATEST_SCHEMA_VERSION,
    );
    db.close();
  }
});

test('wrong owner and failed migration cannot partially upgrade a legacy database', (t) => {
  const root = temporary(t),
    path = resolve(root, 'legacy.sqlite');
  let db = legacyDatabase(path, 'cedar');
  db.close();
  assert.throws(() => openDatabase(path, 'cookie-dough'), /different profile/);
  db = new DatabaseSync(path);
  assert.equal(databaseSchemaVersion(db), 1);
  assert.equal(
    db.prepare("SELECT count(*) n FROM pragma_table_info('procedures') WHERE name='category'").get()
      ?.n,
    0,
  );
  db.exec('CREATE INDEX procedures_category_date ON procedures(id)');
  db.close();
  assert.throws(() => openDatabase(path, 'cedar'), /already exists/);
  db = new DatabaseSync(path);
  assert.equal(databaseSchemaVersion(db), 1);
  assert.equal(
    db.prepare("SELECT count(*) n FROM pragma_table_info('procedures') WHERE name='category'").get()
      ?.n,
    0,
  );
  assert.equal(db.prepare('SELECT content FROM notes').get()?.content, 'Unchanged words');
  db.close();
});

test('procedure categories separate clinical and tests with correct filtering, pagination and unrestricted detail', async (t) => {
  const root = temporary(t),
    db = openDatabase(resolve(root, 'database.sqlite'), 'cedar');
  t.after(() => db.close());
  seedBase(db);
  const categories = [
    'surgery',
    'clinical_procedure',
    'imaging',
    'laboratory',
    'pathology',
    'unspecified',
  ];
  const insert = db.prepare(
    "INSERT INTO procedures(id,source_record_id,provider_id,label,effective_at,status,extra_json,category) VALUES(?,'raw','issuer',?,'2026-09-10','completed','{\"evidenceBasis\":\"original evidence\"}',?)",
  );
  categories.forEach((category) => insert.run(category, 'Shared ' + category, category));
  db.exec(
    "INSERT INTO medications(id,source_record_id,kind,label) VALUES('med','raw','order','Medication is unchanged')",
  );
  const defaultList = clinicalList(db, 'procedures', new URLSearchParams());
  assert.equal(defaultList.total, 4);
  assert.equal(defaultList.complete, true);
  assert.deepEqual(defaultList.data.map((r) => r.category).sort(), [
    'clinical_procedure',
    'imaging',
    'surgery',
    'unspecified',
  ]);
  const tests = clinicalList(
    db,
    'procedures',
    new URLSearchParams({ category: 'tests', limit: '1', offset: '1' }),
  );
  assert.equal(tests.total, 2);
  assert.equal(tests.data.length, 1);
  assert.equal(tests.complete, false);
  assert.equal(clinicalList(db, 'procedures', new URLSearchParams({ category: 'all' })).total, 6);
  const exact = clinicalList(
    db,
    'procedures',
    new URLSearchParams({
      category: 'imaging',
      providerId: 'issuer',
      q: 'Shared',
    }),
  );
  assert.equal(exact.total, 1);
  assert.equal(exact.data[0]!.category, 'imaging');
  assert.equal(
    clinicalList(db, 'procedures', new URLSearchParams({ category: 'tests', q: 'nothing' })).total,
    0,
  );
  const detail = clinicalList(
    db,
    'procedures',
    new URLSearchParams({ category: 'clinical' }),
    'laboratory',
  );
  assert.ok(!('reclassifiedTo' in detail));
  assert.equal(detail.category, 'laboratory');
  assert.equal(detail.sourceRecordId, 'raw');
  assert.equal(detail.provider, 'Source issuer');
  assert.equal(detail.status, 'completed');
  assert.equal(detail.date, '2026-09-10');
  assert.deepEqual(detail.extra, { evidenceBasis: 'original evidence' });
  assert.throws(
    () => clinicalList(db, 'procedures', new URLSearchParams({ category: 'made-up' })),
    (error) => hasCode(error, 'INVALID_CATEGORY'),
  );
  assert.equal(
    clinicalList(db, 'medications', new URLSearchParams({ category: 'made-up', status: 'all' }))
      .total,
    1,
  );
  const app = createApp({ root, databases: new Map([['cedar', db]]) });
  await new Promise<void>((resolveListen) => app.server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>((resolveClose) => app.server.close(() => resolveClose())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/cedar/procedures`;
  let response = await fetch(base + '?category=tests');
  const listPayload = (await response.json()) as {
    meta: { total: number; complete: boolean };
    data: Array<{ category: string }>;
  };
  assert.equal(listPayload.meta.total, 2);
  assert.equal(listPayload.meta.complete, true);
  assert.deepEqual(listPayload.data.map((p) => p.category).sort(), ['laboratory', 'pathology']);
  response = await fetch(base + '/pathology?category=clinical');
  const detailPayload = (await response.json()) as {
    data: { category: string; evidence: unknown[] };
  };
  assert.equal(response.status, 200);
  assert.equal(detailPayload.data.category, 'pathology');
  assert.deepEqual(detailPayload.data.evidence, []);
  response = await fetch(base + '?category=invalid');
  assert.equal(response.status, 400);
  response = await fetch(base.replace(/\/procedures$/, '/overview'));
  const overviewPayload = (await response.json()) as { data: { counts: { procedures: number } } };
  assert.equal(overviewPayload.data.counts.procedures, 4);
});

test('new profiles and portable backups record the current schema, and restored procedure classifications and conditions survive reopening', async (t) => {
  const root = temporary(t),
    db = openDatabase(resolve(root, 'data/profiles/cookie-dough.sqlite'), 'cookie-dough');
  t.after(() => db.close());
  assert.equal(databaseSchemaVersion(db), LATEST_SCHEMA_VERSION);
  assert.equal(
    db.prepare("SELECT display_name FROM people WHERE id='patient'").get()?.display_name,
    'Cookie Dough',
  );
  const sourcePath = 'providers/cookie-dough/procedure.json',
    sourceBytes = Buffer.from('{"synthetic":true}');
  mkdirSync(resolve(root, 'providers/cookie-dough'), { recursive: true });
  writeFileSync(resolve(root, sourcePath), sourceBytes);
  db.prepare('INSERT INTO source_files(id,path,sha256,bytes) VALUES(?,?,?,?)').run(
    'placebo-source',
    sourcePath,
    hash(sourceBytes),
    sourceBytes.length,
  );
  db.prepare('INSERT INTO source_records(id,source_file_id,raw_json) VALUES(?,?,?)').run(
    'placebo-record',
    'placebo-source',
    sourceBytes.toString(),
  );
  db.prepare('INSERT INTO procedures(id,source_record_id,label,category) VALUES(?,?,?,?)').run(
    'placebo-procedure',
    'placebo-record',
    'Fictional procedure',
    'surgery',
  );
  const objects = new Map<string, Buffer>();
  const storage: RecordStorage = {
    read: (name) => objects.get(name) ?? null,
    writeImmutable: (name, bytes) => {
      assert.equal(objects.has(name), false);
      objects.set(name, Buffer.from(bytes));
    },
    publishHead: (bytes) => {
      objects.set('head', Buffer.from(bytes));
    },
  };
  attachRecordDurability(db, { profileId: 'cookie-dough', storage });
  transaction(
    db,
    () =>
      db.exec(
        "INSERT INTO conditions(id,source_record_id,person_id,label,status,extra_json) VALUES('condition','placebo-record','patient','Fictional condition','source wording','{\"printedCode\":\"F00.001\",\"nullable\":null}')",
      ),
    { actor: 'fictional-reviewer', origin: 'condition-storage-fixture' },
  );
  transaction(
    db,
    () => db.exec("UPDATE conditions SET effective_at='2021-04' WHERE id='condition'"),
    { actor: 'fictional-caregiver' },
  );
  const expectedConditions = db.prepare('SELECT * FROM conditions').all();
  const historyQuery = { profileId: 'cookie-dough', entity: 'conditions', recordId: 'condition' };
  const expectedHistory = queryRecordHistory(db, historyQuery);
  assert.equal(expectedHistory.entries.length, 2);
  const receipt = await createBackup(db, root, 'cookie-dough');
  const manifest = JSON.parse(readFileSync(resolve(receipt.path, 'manifest.json'), 'utf8')),
    portable = JSON.parse(readFileSync(resolve(receipt.path, 'portable.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, LATEST_SCHEMA_VERSION);
  assert.equal(portable.schemaVersion, LATEST_SCHEMA_VERSION);
  const target = resolve(root, 'restored');
  restoreBackup(receipt.path, target);
  const restored = openDatabase(
    resolve(target, 'data/profiles/cookie-dough.sqlite'),
    'cookie-dough',
  );
  assert.equal(databaseSchemaVersion(restored), LATEST_SCHEMA_VERSION);
  assert.equal(
    restored.prepare('SELECT category FROM procedures WHERE id=?').get('placebo-procedure')
      ?.category,
    'surgery',
  );
  assert.equal(
    restored.prepare("SELECT name FROM pragma_table_info('procedures') WHERE name='category'").get()
      ?.name,
    'category',
  );
  assert.deepEqual(restored.prepare('SELECT * FROM conditions').all(), expectedConditions);
  // This exercises snapshot history restoration, not rebuilding it from the test's journal.
  // Archive-only recovery is covered separately by condition-storage.test.ts.
  const head = objects.get('head')!;
  objects.clear();
  attachRecordDurability(restored, {
    profileId: 'cookie-dough',
    storage: {
      read: (name) => {
        assert.equal(name, 'head', 'restore must not replay missing snapshot history');
        return head;
      },
      writeImmutable: () => assert.fail('restore must not invent historical versions'),
      publishHead: () => assert.fail('restore must not replace the accepted head'),
    },
  });
  assert.deepEqual(queryRecordHistory(restored, historyQuery), expectedHistory);
  restored.close();
});
