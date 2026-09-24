import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { transaction, revision, type Database } from '../database.ts';
import { clinicalList, setMedicationCurrentStatus, type MedicationDTO } from '../queries.ts';
import { visibilityState, setVisibility } from '../visibility.ts';
import { hash } from '../assets.ts';
import { appendImportedMedicationDefault } from '../medication-preferences.ts';
import { vaultFixture, newProfile } from './helpers/vault-fixture.ts';
import { profileOriginal } from '../profile-storage.ts';
import type { MedicationCurrentStatus } from '../../shared/api.ts';

async function fixture(t: TestContext) {
  const fixture = vaultFixture(t);
  const created = await newProfile(fixture.manager);
  const state = fixture.manager.opened.get(created.profile.id);
  assert.ok(state);
  const bytes = Buffer.from(
    '{"medication":"Synthetic order","status":"active","dose":"5.000 mg"}\n',
  );
  const path = `data/profiles/${created.profile.id}/sources/synthetic-medication.json`;
  writeFileSync(resolve(state.root, path), bytes);
  transaction(state.db, () => {
    state.db
      .prepare("INSERT INTO source_files(id,path,sha256,bytes) VALUES('file',?,?,?)")
      .run(path, hash(bytes), bytes.length);
    state.db
      .prepare("INSERT INTO source_records(id,source_file_id,raw_json) VALUES('raw','file',?)")
      .run(bytes.toString());
    state.db.exec(
      "INSERT INTO medications(id,source_record_id,label,status,kind) VALUES('med','raw','Synthetic medicine','active','order')",
    );
  });
  return { ...fixture, ...created, state, path, bytes, db: state.db };
}
function detail(db: Database): MedicationDTO {
  const value = clinicalList(db, 'medications', new URLSearchParams(), 'med');
  assert.ok(!('reclassifiedTo' in value));
  return value;
}
const list = (db: Database, status: string) =>
  clinicalList(db, 'medications', new URLSearchParams({ status }));
function select(db: Database, status: MedicationCurrentStatus): MedicationDTO {
  const current = detail(db);
  const value = setMedicationCurrentStatus(db, 'med', {
    status,
    version: current.currentStatusVersion,
    visibilityVersion: current.visibilityVersion,
  });
  assert.ok(!('reclassifiedTo' in value));
  return value;
}

test('historic unknown prescriptions are shown as inactive without rewriting their retained state', async (t) => {
  const { db } = await fixture(t);
  assert.equal(detail(db).currentStatus, 'unknown');
  assert.equal(list(db, 'current').total, 0);
  assert.equal(list(db, 'archived').total, 1);
  assert.equal(list(db, 'unreviewed').total, 1, 'old serialized filters resolve to Inactive');
  assert.equal(db.prepare('SELECT count(*) AS n FROM medication_preferences').get()?.n, 0);
  select(db, 'current');
  // Retained pre-combination state: archived visibility with an older current assertion.
  transaction(db, () =>
    db.exec(
      "INSERT INTO visibility_events VALUES('old-archive','medication','med',1,1,'2026-01-01','Profile owner')",
    ),
  );
  const before = revision(db);
  assert.equal(detail(db).archived, true);
  assert.equal(detail(db).currentStatus, 'current');
  assert.equal(detail(db).archiveHistory?.[0]?.id, 'old-archive');
  assert.equal(list(db, 'current').total, 0);
  assert.equal(list(db, 'archived').total, 1);
  assert.equal(list(db, 'unreviewed').total, 1);
  assert.equal(list(db, 'all').total, 1);
  assert.equal(revision(db), before);
  assert.equal(
    select(db, 'current').archived,
    false,
    'an intentional Current selection resolves the previous archive',
  );
});

test('an imported inactive default is durable, idempotent, and never overwrites an active choice', async (t) => {
  const { manager, profile, recoveryKit, db } = await fixture(t);
  transaction(db, () => appendImportedMedicationDefault(db, 'med'));
  const first = db.prepare('SELECT * FROM medication_preferences WHERE medication_id=?').get('med');
  assert.ok(first);
  assert.equal(first.status, 'not_current');
  assert.equal(JSON.parse(String(first.assertion_json)).source, 'system_default');
  assert.equal(detail(db).currentStatus, 'not_current');
  const active = select(db, 'current');
  transaction(db, () => appendImportedMedicationDefault(db, 'med'));
  assert.equal(detail(db).currentStatus, 'current');
  assert.equal(detail(db).currentStatusVersion, active.currentStatusVersion);
  manager.lock(profile.id);
  rmSync(resolve(manager.pathFor(profile.id), 'cache'), { recursive: true, force: true });
  manager.unlock(profile.id, recoveryKit);
  const reopened = manager.opened.get(profile.id);
  assert.ok(reopened);
  assert.equal(detail(reopened.db).currentStatus, 'current');
});

test('both versions protect both mutation routes and stale or failed switches roll back the entire change', async (t) => {
  const { db } = await fixture(t);
  const current = select(db, 'current');
  const original = db.prepare('SELECT * FROM medications').get();
  const before = revision(db);
  const preference = db.prepare('SELECT * FROM medication_preferences').get();
  assert.throws(
    () => setMedicationCurrentStatus(db, 'med', { status: 'not_current', version: 1 }),
    { code: 'INVALID_INPUT' },
  );
  assert.throws(() => setVisibility(db, 'medication', 'med', { archived: true, version: 0 }), {
    code: 'INVALID_INPUT',
  });
  assert.throws(
    () =>
      setMedicationCurrentStatus(db, 'med', {
        status: 'not_current',
        version: 0,
        visibilityVersion: 0,
      }),
    { code: 'VERSION_CONFLICT' },
  );
  assert.throws(
    () =>
      setMedicationCurrentStatus(db, 'med', {
        status: 'not_current',
        version: 1,
        visibilityVersion: 9,
      }),
    { code: 'VERSION_CONFLICT' },
  );
  assert.throws(
    () =>
      setVisibility(db, 'medication', 'med', {
        archived: true,
        version: 9,
        currentStatusVersion: 1,
      }),
    { code: 'VERSION_CONFLICT' },
  );
  assert.throws(
    () =>
      setVisibility(db, 'medication', 'med', {
        archived: true,
        version: 0,
        currentStatusVersion: 0,
      }),
    { code: 'VERSION_CONFLICT' },
  );
  assert.equal(revision(db), before);
  assert.deepEqual(db.prepare('SELECT * FROM medication_preferences').get(), preference);
  assert.equal(visibilityState(db, 'medication', 'med').history.length, 0);
  db.exec(
    "CREATE TEMP TRIGGER reject_archive BEFORE INSERT ON visibility_events BEGIN SELECT RAISE(ABORT,'injected archive failure'); END",
  );
  assert.throws(() => select(db, 'not_current'), /injected archive failure/);
  db.exec('DROP TRIGGER reject_archive');
  assert.deepEqual(db.prepare('SELECT * FROM medication_preferences').get(), preference);
  assert.equal(revision(db), before);
  const archived = setVisibility(db, 'medication', 'med', {
    archived: true,
    version: current.visibilityVersion,
    currentStatusVersion: current.currentStatusVersion,
  });
  assert.equal(archived.archived, true);
  assert.equal(detail(db).currentStatus, 'not_current');
  setVisibility(db, 'medication', 'med', {
    archived: false,
    version: archived.version,
    currentStatusVersion: archived.currentStatusVersion,
  });
  assert.equal(detail(db).currentStatus, 'current');
  assert.equal(detail(db).archived, false);
  assert.deepEqual(db.prepare('SELECT * FROM medications').get(), original);
});

test('current/archive/current survives complete cache loss with originals and both histories intact', async (t) => {
  const { manager, profile, recoveryKit, db, path, bytes } = await fixture(t);
  const source = db.prepare('SELECT * FROM source_records').get();
  const medication = db.prepare('SELECT * FROM medications').get();
  select(db, 'current');
  select(db, 'not_current');
  select(db, 'current');
  const preferences = db
    .prepare(
      "SELECT sequence,contents_json FROM __record_versions WHERE entity='medication_preferences' ORDER BY sequence",
    )
    .all();
  const visibility = db
    .prepare(
      "SELECT sequence,contents_json FROM __record_versions WHERE entity='visibility_events' ORDER BY sequence",
    )
    .all();
  assert.deepEqual(
    preferences.map((row) => JSON.parse(String(row.contents_json)).status),
    ['current', 'not_current', 'current'],
  );
  assert.deepEqual(
    visibility.map((row) => row.sequence),
    preferences.slice(1).map((row) => row.sequence),
    'each archive state is published in its personal-use transaction',
  );
  manager.lock(profile.id);
  rmSync(resolve(manager.pathFor(profile.id), 'cache'), { recursive: true, force: true });
  manager.unlock(profile.id, recoveryKit);
  const restored = manager.opened.get(profile.id);
  assert.ok(restored);
  assert.equal(restored.metrics.cacheHit, false);
  assert.equal(detail(restored.db).currentStatus, 'current');
  assert.equal(detail(restored.db).archived, false);
  assert.deepEqual(
    restored.db
      .prepare(
        "SELECT sequence,contents_json FROM __record_versions WHERE entity='medication_preferences' ORDER BY sequence",
      )
      .all(),
    preferences,
  );
  assert.deepEqual(
    restored.db
      .prepare(
        "SELECT sequence,contents_json FROM __record_versions WHERE entity='visibility_events' ORDER BY sequence",
      )
      .all(),
    visibility,
  );
  assert.deepEqual(restored.db.prepare('SELECT * FROM source_records').get(), source);
  assert.deepEqual(restored.db.prepare('SELECT * FROM medications').get(), medication);
  assert.equal(existsSync(resolve(restored.root, path)), false, 'Original plaintext is deferred');
  assert.deepEqual(readFileSync(profileOriginal(restored.root, path, profile.id)), bytes);
});
