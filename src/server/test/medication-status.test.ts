import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  openDatabase,
  revision,
  databaseSchemaVersion,
  LATEST_SCHEMA_VERSION,
  type Database,
} from '../database.ts';
import { clinicalList, setMedicationCurrentStatus, type MedicationDTO } from '../queries.ts';
import { createApp } from '../index.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import { attachPersonalDurability, exportCuration, rebuildProfile } from '../portable.ts';
import { createBackup, restoreBackup } from '../recovery.ts';
import { hash } from '../assets.ts';
import type { MedicationCurrentStatus } from '../../shared/api.ts';
interface Page<T> {
  data: T[];
  total: number;
  complete: boolean;
}

function fixture(t: TestContext, profileId = 'cedar') {
  const root = mkdtempSync(resolve(tmpdir(), 'health-medication-status-'));
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const sourcePath = paths.relativeRoot + '/sources/fixture.json';
  const source = Buffer.from(
    '{"data":{"recordedDate":"2021-03-08T00:00:00.000Z","number":1.0000}}',
  );
  writeFileSync(resolve(root, sourcePath), source);
  db.exec("INSERT INTO providers VALUES('issuer','Source issuer'),('other','Other issuer')");
  db.prepare("INSERT INTO source_files(id,path,sha256,bytes) VALUES('file',?,?,?)").run(
    sourcePath,
    hash(source),
    source.length,
  );
  db.prepare("INSERT INTO source_records(id,source_file_id,raw_json) VALUES('raw','file',?)").run(
    source.toString(),
  );
  return { db, root, paths, profileId };
}
interface AddOptions {
  providerId?: string;
  kind?: string;
  label?: string;
  startAt?: string;
  endAt?: string;
  extra?: unknown;
}
function add(db: Database, id: string, sourceStatus: string | null, options: AddOptions = {}) {
  db.prepare(
    "INSERT INTO medications(id,source_record_id,provider_id,kind,label,status,start_at,end_at,extra_json) VALUES(?,'raw',?,?,?,?,?,?,?)",
  ).run(
    id,
    options.providerId || 'issuer',
    options.kind || 'order',
    options.label || 'Fixture ' + id,
    sourceStatus,
    options.startAt ?? null,
    options.endAt ?? null,
    JSON.stringify(options.extra || {}),
  );
}
function list(db: Database, params?: Record<string, string>): Page<MedicationDTO>;
function list(db: Database, params: Record<string, string>, id: string): MedicationDTO;
function list(
  db: Database,
  params: Record<string, string> = {},
  id?: string,
): Page<MedicationDTO> | MedicationDTO {
  if (!id) return clinicalList(db, 'medications', new URLSearchParams(params));
  const value = clinicalList(db, 'medications', new URLSearchParams(params), id);
  assert.ok(!('reclassifiedTo' in value));
  return value;
}
const choose = (
  db: Database,
  id: string,
  status: MedicationCurrentStatus,
  version = 0,
): MedicationDTO => {
  const value = setMedicationCurrentStatus(db, id, {
    status,
    version,
    visibilityVersion: list(db, {}, id).visibilityVersion,
  });
  assert.ok(!('reclassifiedTo' in value));
  return value;
};
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

test('historical source-active records are presented as Inactive until a personal assertion', (t) => {
  const { db } = fixture(t);
  add(db, 'old-ibuprofen', 'active', {
    startAt: '2021-03-08',
    label: 'Ibuprofen',
  });
  add(db, 'dated-report', 'user-reported current as of 2026-09-10', {
    kind: 'reported_use',
    extra: { asOf: '2026-09-10' },
  });
  add(db, 'stopped-order', 'stopped');
  add(db, 'unknown-source', null);
  assert.equal(list(db).total, 0);
  assert.equal(list(db, { status: 'inactive' }).total, 4);
  assert.equal(
    list(db, { status: 'unknown' }).total,
    4,
    'legacy unknown links resolve to Inactive',
  );
  const before = db.prepare('SELECT * FROM medications ORDER BY id').all();
  const raw = db.prepare('SELECT * FROM source_records').all();
  const unknown = list(db, {}, 'old-ibuprofen');
  assert.equal(unknown.currentStatus, 'unknown');
  assert.equal(unknown.currentStatusVersion, 0);
  assert.equal(unknown.currentStatusUpdatedAt, null);
  choose(db, 'old-ibuprofen', 'not_current');
  const personal = choose(db, 'dated-report', 'current');
  assert.equal(personal.currentStatus, 'current');
  assert.equal(personal.currentStatusVersion, 1);
  assert.match(personal.currentStatusUpdatedAt!, /Z$/);
  assert.equal(
    (personal.currentStatusAssertion as { source: string }).source,
    'personal_confirmation',
  );
  assert.equal(personal.status, 'user-reported current as of 2026-09-10');
  assert.equal(list(db).data[0]!.id, 'dated-report');
  assert.equal(list(db, { status: 'inactive' }).data[0]!.id, 'old-ibuprofen');
  assert.equal(list(db, { status: 'unknown' }).total, 3);
  assert.equal(list(db, { status: 'all' }).total, 4);
  add(db, 'new-import', 'active');
  assert.equal(list(db).total, 1);
  assert.equal(list(db, { status: 'unknown' }).total, 4);
  assert.deepEqual(
    db.prepare("SELECT * FROM medications WHERE id!='new-import' ORDER BY id").all(),
    before,
  );
  assert.deepEqual(db.prepare('SELECT * FROM source_records').all(), raw);
});

test('personal CAS updates reject stale requests and source edits while preserving prior assertion context', (t) => {
  const { db } = fixture(t);
  add(db, 'med', 'active');
  const initial = choose(db, 'med', 'current');
  const before = revision(db);
  assert.throws(
    () => choose(db, 'med', 'not_current', 0),
    (e) => hasCode(e, 'VERSION_CONFLICT'),
  );
  assert.equal(revision(db), before);
  for (const input of [
    { status: 'active', version: 1 },
    { status: 'current' },
    { status: 'current', version: -1 },
    { status: 'current', version: 1, doseText: 'overwrite' },
  ])
    assert.throws(
      () => setMedicationCurrentStatus(db, 'med', input),
      (e) => hasCode(e, 'INVALID_INPUT'),
    );
  const reset = choose(db, 'med', 'unknown', initial.currentStatusVersion);
  assert.equal(reset.currentStatusVersion, 2);
  assert.equal(reset.currentStatus, 'unknown');
  assert.equal(
    (reset.currentStatusAssertion as { previousAssertion: { source: string } }).previousAssertion
      .source,
    'personal_confirmation',
  );
  assert.equal(list(db).total, 0);
  assert.equal(list(db, { status: 'unknown' }).total, 1);
  assert.equal(
    list(db, { status: 'invalid' }, 'med').id,
    'med',
    'deep links are independent of list filters',
  );
  assert.throws(
    () => choose(db, 'missing', 'current'),
    (e) => e instanceof Error && 'status' in e && e.status === 404,
  );
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO medication_preferences(medication_id,status,updated_at) VALUES('missing','current','today')",
        )
        .run(),
    /FOREIGN KEY/,
  );
  assert.throws(
    () => db.prepare("UPDATE medication_preferences SET status='active'").run(),
    /CHECK/,
  );
});

test('status, search, provider and pagination compose without affecting procedure filters', (t) => {
  const { db } = fixture(t);
  for (const id of ['a', 'b', 'c', 'd', 'e'])
    add(db, id, 'active', {
      label: 'Matching medicine',
      providerId: id === 'c' ? 'other' : 'issuer',
    });
  for (const id of ['a', 'b', 'c']) choose(db, id, 'current');
  choose(db, 'd', 'not_current');
  const first = list(db, { q: 'Matching', providerId: 'issuer', limit: '1' });
  const second = list(db, {
    q: 'Matching',
    providerId: 'issuer',
    limit: '1',
    offset: '1',
  });
  assert.equal(first.total, 2);
  assert.equal(first.complete, false);
  assert.deepEqual([first.data[0]!.id, second.data[0]!.id], ['a', 'b']);
  assert.equal(list(db, { status: 'inactive', q: 'Matching' }).total, 2);
  assert.equal(list(db, { status: 'unknown', q: 'Matching' }).total, 2);
  assert.equal(list(db, { status: 'all', q: 'Matching' }).total, 5);
  assert.equal(list(db, { providerId: 'other' }).data[0]!.id, 'c');
  assert.throws(
    () => list(db, { status: 'unsupported' }),
    (e) => hasCode(e, 'INVALID_STATUS'),
  );
  db.exec(
    "INSERT INTO procedures(id,source_record_id,label,status,category) VALUES('surgery','raw','Recorded surgery','completed','surgery')",
  );
  assert.equal(
    clinicalList(db, 'procedures', new URLSearchParams({ status: 'unknown' })).data[0]!.id,
    'surgery',
  );
});

test('source recorded dates are read literally without becoming start dates or personal confirmation dates', (t) => {
  const { db } = fixture(t);
  add(db, 'med', 'active');
  const detail = list(db, {}, 'med');
  assert.equal(detail.sourceRecordedDate, '2021-03-08T00:00:00.000Z');
  assert.equal(detail.startAt, null);
  assert.equal(detail.endAt, null);
  assert.equal(detail.currentStatusUpdatedAt, null);
  db.prepare('UPDATE source_records SET raw_json=?').run('{"recordedDate":"2020-04"}');
  assert.equal(list(db, {}, 'med').sourceRecordedDate, '2020-04');
  db.prepare('UPDATE source_records SET raw_json=?').run(
    '{"data":{"authoredOn":"2021-03-08","recordedDate":42}}',
  );
  assert.equal(list(db, {}, 'med').sourceRecordedDate, null);
  db.prepare('UPDATE medications SET extra_json=?').run(
    '{"sourceFields":{"recordedDate":"2022-06-14"}}',
  );
  assert.equal(list(db, {}, 'med').sourceRecordedDate, '2022-06-14');
});

test('HTTP current-status mutations are origin/profile bounded, report CAS errors and leave source rows unchanged', async (t) => {
  const f = fixture(t),
    placebo = fixture(t, 'cookie-dough'),
    { db, root } = f;
  add(db, 'private', 'active');
  add(placebo.db, 'placebo', 'active');
  const before = db.prepare('SELECT * FROM medications').all();
  const app = createApp({
    root,
    databases: new Map([
      ['cedar', db],
      ['cookie-dough', placebo.db],
    ]),
  });
  await new Promise<void>((resolveListen) => app.server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>((resolveClose) => app.server.close(() => resolveClose())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles`;
  const body = JSON.stringify({ status: 'not_current', version: 0, visibilityVersion: 0 });
  let response = await fetch(base + '/cedar/medications/private/current-status', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(response.status, 403);
  const headers = {
    Origin: 'http://127.0.0.1:5173',
    'Content-Type': 'application/json',
  };
  response = await fetch(base + '/cookie-dough/medications/private/current-status', {
    method: 'PATCH',
    headers,
    body,
  });
  assert.equal(response.status, 404);
  response = await fetch(base + '/cedar/medications/private/current-status', {
    method: 'PATCH',
    headers,
    body,
  });
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { data: MedicationDTO };
  assert.equal(payload.data.currentStatus, 'not_current');
  assert.equal(payload.data.status, 'active');
  assert.deepEqual(payload.data.evidence, []);
  assert.deepEqual(payload.data.attachments, []);
  response = await fetch(base + '/cedar/medications/private/current-status', {
    method: 'PATCH',
    headers,
    body,
  });
  assert.equal(response.status, 409);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    'VERSION_CONFLICT',
  );
  assert.equal(
    (
      (await (await fetch(base + '/cedar/medications')).json()) as {
        meta: { total: number };
      }
    ).meta.total,
    0,
  );
  assert.equal(
    (
      (await (await fetch(base + '/cedar/medications?status=inactive')).json()) as {
        meta: { total: number };
      }
    ).meta.total,
    1,
  );
  assert.equal(
    (
      (await (await fetch(base + '/cedar/medications/private?status=active')).json()) as {
        data: MedicationDTO;
      }
    ).data.currentStatus,
    'not_current',
  );
  assert.deepEqual(db.prepare('SELECT * FROM medications').all(), before);
  assert.equal(placebo.db.prepare('SELECT COUNT(*) n FROM medication_preferences').get()?.n, 0);
});

test('schema 3 upgrades without inferring any medication current use', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'health-schema4-')),
    path = resolve(root, 'legacy.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let db = new DatabaseSync(path);
  for (const file of [
    '001-initial.sql',
    '002-procedure-categories.sql',
    '003-note-series-links.sql',
  ])
    db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  db.exec(
    "INSERT INTO app_meta VALUES('owner_profile_id','cedar'); INSERT INTO source_files(id,path,sha256,bytes) VALUES('file','file.json','x',1); INSERT INTO source_records(id,source_file_id,raw_json) VALUES('raw','file','{}'); INSERT INTO medications(id,source_record_id,kind,label,status) VALUES('old','raw','order','Old active order','active')",
  );
  const raw = db.prepare('SELECT * FROM medications').get();
  db.close();
  db = openDatabase(path, 'cedar');
  assert.equal(databaseSchemaVersion(db), LATEST_SCHEMA_VERSION);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM medication_preferences').get()?.n, 0);
  assert.deepEqual(db.prepare('SELECT * FROM medications').get(), raw);
  assert.equal(list(db).total, 0);
  db.close();
});

test('personal medication assertions survive autosave, rebuild and backup without entering clinical curation', async (t) => {
  const { db, root, paths } = fixture(t);
  add(db, 'med', 'active');
  attachPersonalDurability(db, { root, profileId: 'cedar' });
  exportCuration(db, root, 'cedar');
  const curationBefore = readFileSync(resolve(paths.curation, 'current.json'), 'utf8');
  choose(db, 'med', 'not_current');
  const expected = db.prepare('SELECT * FROM medication_preferences').get();
  const rebuilt = rebuildProfile(root, 'cedar', resolve(root, 'rebuilt'));
  let restored = new DatabaseSync(rebuilt.database);
  assert.deepEqual(restored.prepare('SELECT * FROM medication_preferences').get(), expected);
  restored.close();
  assert.equal(readFileSync(resolve(paths.curation, 'current.json'), 'utf8'), curationBefore);
  const receipt = await createBackup(db, root, 'cedar');
  restoreBackup(receipt.path, resolve(root, 'backup-restored'));
  restored = new DatabaseSync(profilePaths(resolve(root, 'backup-restored'), 'cedar').database);
  assert.deepEqual(restored.prepare('SELECT * FROM medication_preferences').get(), expected);
  restored.close();
});

test('current-schema portable snapshots reject a missing medication preference table', (t) => {
  const { db, root, paths } = fixture(t);
  add(db, 'med', 'active');
  exportCuration(db, root, 'cedar');
  const pointer = resolve(paths.personal, 'current.json');
  const manifest = JSON.parse(readFileSync(pointer, 'utf8'));
  const path = resolve(paths.personal, manifest.file);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  delete value.tables.medication_preferences;
  const bytes = Buffer.from(JSON.stringify(value));
  writeFileSync(path, bytes);
  writeFileSync(pointer, JSON.stringify({ ...manifest, sha256: hash(bytes), bytes: bytes.length }));
  assert.throws(
    () => rebuildProfile(root, 'cedar', resolve(root, 'missing-preferences')),
    /portable table ownership/,
  );
});

test('a read-only current-schema database can create a backup that restores and rebuilds without inferring medication use', async (t) => {
  const { db, root, paths } = fixture(t);
  add(db, 'old-active-order', 'active', {
    startAt: '2021-03-08',
    extra: { unknown: { preserved: true } },
  });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const expected = Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('schema_migrations','app_meta') ORDER BY name",
      )
      .all()
      .map(({ name }) => [
        name,
        db
          .prepare(`SELECT * FROM \"${name}\"`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
  );
  expected.notes = expected.notes
    .map((row: string) => JSON.stringify({ ...JSON.parse(row), text_formats_json: '{}' }))
    .sort();
  db.close();
  const old = new DatabaseSync(paths.database, { readOnly: true });
  let receipt;
  try {
    receipt = await createBackup(old, root, 'cedar');
    assert.equal(databaseSchemaVersion(old), LATEST_SCHEMA_VERSION);
    assert.equal(old.prepare('SELECT COUNT(*) n FROM medication_preferences').get()?.n, 0);
  } finally {
    old.close();
  }
  const target = resolve(root, 'legacy-modern-restored');
  restoreBackup(receipt.path, target);
  const restoredPath = profilePaths(target, 'cedar').database;
  let restored = openDatabase(restoredPath, 'cedar');
  for (const [table, rows] of Object.entries(expected))
    assert.deepEqual(
      restored
        .prepare(`SELECT * FROM \"${table}\"`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
      rows,
    );
  assert.equal(databaseSchemaVersion(restored), LATEST_SCHEMA_VERSION);
  assert.equal(list(restored).total, 0);
  assert.equal(list(restored, { status: 'unknown' }).total, 1);
  restored.close();
  rmSync(restoredPath);
  const rebuilt = rebuildProfile(target, 'cedar', resolve(root, 'legacy-modern-rebuilt'));
  restored = openDatabase(rebuilt.database, 'cedar');
  for (const [table, rows] of Object.entries(expected))
    assert.deepEqual(
      restored
        .prepare(`SELECT * FROM \"${table}\"`)
        .all()
        .map((row) => JSON.stringify(row))
        .sort(),
      rows,
    );
  assert.equal(databaseSchemaVersion(restored), LATEST_SCHEMA_VERSION);
  assert.equal(restored.prepare('SELECT COUNT(*) n FROM medication_preferences').get()?.n, 0);
  restored.close();
});

test('current-schema backups refuse a missing personal medication table instead of silently losing it', async (t) => {
  const { db, root } = fixture(t);
  add(db, 'med', 'active');
  db.exec('DROP TABLE medication_preferences');
  await assert.rejects(createBackup(db, root, 'cedar'), /no such table: medication_preferences/);
});
