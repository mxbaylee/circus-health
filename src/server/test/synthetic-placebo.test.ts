import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, transaction, type Database } from '../database.ts';
import { attachPersonalDurability, exportCuration, rebuildProfile } from '../portable.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import { seedSyntheticPlacebo, SYNTHETIC_PLACEBO_SEED } from '../synthetic-placebo.ts';

type FixtureSuffix = 'first' | 'second' | 'rebuild';
function fixture(t: TestContext, suffix: FixtureSuffix) {
  const root = mkdtempSync(resolve(tmpdir(), `health-synthetic-${suffix}-`));
  const ids = {
    first: 'p-00000000-0000-4000-8000-000000000001',
    second: 'p-00000000-0000-4000-8000-000000000002',
    rebuild: 'p-00000000-0000-4000-8000-000000000003',
  };
  const profileId = ids[suffix];
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  transaction(db, () => {
    db.prepare("UPDATE people SET display_name='Nova Example' WHERE id='patient'").run();
    db.prepare(
      "UPDATE notes SET title='Nova Example',profile_json=? WHERE id='person-note:self'",
    ).run(JSON.stringify({ name: 'Nova Example', relationship: 'Self', lifeStatus: 'unknown' }));
  });
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profileId, paths, db };
}
const rows = (db: Database, table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();

test('synthetic placebo generation is rich, explicitly fictional and deterministic for the same seed', (t) => {
  const first = fixture(t, 'first'),
    second = fixture(t, 'second');
  const one = seedSyntheticPlacebo(first.db, {
    root: first.root,
    profileId: first.profileId,
    name: 'Nova Example',
    seed: SYNTHETIC_PLACEBO_SEED,
  });
  const two = seedSyntheticPlacebo(second.db, {
    root: second.root,
    profileId: second.profileId,
    name: 'Nova Example',
    seed: SYNTHETIC_PLACEBO_SEED,
  });
  assert.equal(one.counts.observations, 12);
  assert.equal(one.counts.medications, 3);
  assert.equal(one.counts.procedures, 2);
  assert.equal(one.counts.documents, 1);
  assert.equal(one.counts.people, 3, 'Self plus two invented contacts');
  assert.equal(
    one.counts.notes,
    6,
    'Self plus contacts and a mix of editable, draft and finished notes',
  );
  assert.deepEqual(rows(first.db, 'observations'), rows(second.db, 'observations'));
  assert.deepEqual(rows(first.db, 'medications'), rows(second.db, 'medications'));
  assert.deepEqual(
    rows(first.db, 'notes').filter((row) => row.id !== 'person-note:self'),
    rows(second.db, 'notes').filter((row) => row.id !== 'person-note:self'),
  );
  assert.deepEqual(rows(first.db, 'note_links'), rows(second.db, 'note_links'));
  assert.deepEqual(
    first.db
      .prepare('SELECT status FROM medication_preferences ORDER BY medication_id')
      .all()
      .map((row) => row.status),
    ['unknown', 'current', 'not_current'],
  );
  assert.deepEqual(
    new Set(
      first.db
        .prepare('SELECT category FROM procedures')
        .all()
        .map((row) => row.category),
    ),
    new Set(['surgery', 'imaging']),
  );
  assert.ok(first.db.prepare("SELECT 1 FROM note_links WHERE target_type='test_type'").get());
  assert.ok(first.db.prepare("SELECT 1 FROM note_links WHERE target_type='person'").get());
  assert.ok(first.db.prepare("SELECT 1 FROM evidence WHERE entity_type='observation'").get());
  const source = first.db
    .prepare("SELECT * FROM source_files WHERE id='synthetic-placebo-source'")
    .get();
  assert.ok(source);
  const original = resolve(first.root, String(source.path));
  assert.ok(existsSync(original));
  const text = readFileSync(original, 'utf8');
  assert.match(text, /"fictional":true/);
  assert.match(text, /"patient":"Nova Example"/);
  assert.equal(
    text,
    readFileSync(
      resolve(
        second.root,
        second.db.prepare("SELECT path FROM source_files WHERE id='synthetic-placebo-source'").get()
          ?.path as string,
      ),
      'utf8',
    ),
  );
  assert.throws(
    () =>
      seedSyntheticPlacebo(first.db, {
        root: first.root,
        profileId: first.profileId,
        name: 'Nova Example',
        seed: SYNTHETIC_PLACEBO_SEED,
      }),
    /already seeded/,
  );
  assert.deepEqual(one.counts, two.counts);
});

test('synthetic placebo survives portable export and a database-loss rebuild with source bytes and relationships', (t) => {
  const placebo = fixture(t, 'rebuild');
  seedSyntheticPlacebo(placebo.db, {
    root: placebo.root,
    profileId: placebo.profileId,
    name: 'Nova Example',
    seed: 'rebuild-proof-seed',
  });
  attachPersonalDurability(placebo.db, { root: placebo.root, profileId: placebo.profileId });
  exportCuration(placebo.db, placebo.root, placebo.profileId);
  const destination = resolve(placebo.root, 'rebuilt');
  rebuildProfile(placebo.root, placebo.profileId, destination);
  const rebuilt = openDatabase(
    profilePaths(destination, placebo.profileId).database,
    placebo.profileId,
  );
  try {
    assert.deepEqual(rows(rebuilt, 'observations'), rows(placebo.db, 'observations'));
    assert.deepEqual(
      rows(rebuilt, 'medication_preferences'),
      rows(placebo.db, 'medication_preferences'),
    );
    assert.deepEqual(rows(rebuilt, 'notes'), rows(placebo.db, 'notes'));
    assert.deepEqual(rows(rebuilt, 'note_links'), rows(placebo.db, 'note_links'));
    const file = rebuilt
      .prepare("SELECT path,sha256,bytes FROM source_files WHERE id='synthetic-placebo-source'")
      .get();
    assert.ok(file);
    const rebuiltOriginal = resolve(destination, String(file.path));
    assert.ok(existsSync(rebuiltOriginal));
    assert.deepEqual(
      readFileSync(rebuiltOriginal),
      readFileSync(resolve(placebo.root, String(file.path))),
    );
    assert.equal(
      rebuilt.prepare('SELECT count(*) AS count FROM evidence').get()?.count,
      placebo.db.prepare('SELECT count(*) AS count FROM evidence').get()?.count,
    );
  } finally {
    rebuilt.close();
  }
});
