import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../database.ts';
import { PROFILE_IDS, validProfileId } from '../profiles.ts';
import { readDatabaseOwner } from '../profile-ownership.ts';
import { readProfileRegistry, writeProfileRegistry } from '../profile-registry.ts';
import {
  ensureProfileDirectories,
  existingProfileDatabase,
  legacyDatabasePath,
} from '../profile-storage.ts';
import { createBackup, restoreBackup } from '../recovery.ts';
import { hash, profileFile } from '../assets.ts';
import { attachPersonalDurability, exportCuration, rebuildProfile } from '../portable.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-public-profiles-')),
    opened: DatabaseSync[] = [];
  t.after(() => {
    for (const db of opened) {
      try {
        db.close();
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  const open = (path: string, id?: string) => {
    const db = openDatabase(path, id);
    opened.push(db);
    return db;
  };
  return { root, open };
}
function original(root: string, db: DatabaseSync, path: string, content: string) {
  const bytes = Buffer.from(content);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), bytes);
  db.prepare('INSERT INTO source_files(id,path,sha256,bytes) VALUES(?,?,?,?)').run(
    path,
    path,
    hash(bytes),
    bytes.length,
  );
  db.prepare('INSERT INTO source_records(id,source_file_id,raw_json) VALUES(?,?,?)').run(
    'source:' + path,
    path,
    JSON.stringify({ invented: content }),
  );
  return bytes;
}

test('public defaults contain only fictional seed metadata and safe syntax never grants registry membership', (t) => {
  const f = fixture(t);
  assert.deepEqual(PROFILE_IDS, ['cookie-dough']);
  assert.equal(validProfileId('archive-juniper-1976'), true);
  for (const id of ['../archive', 'a/b', 'p-not-a-uuid', 'a\\b', '', 'a'.repeat(129), '.hidden'])
    assert.equal(validProfileId(id), false);
  assert.deepEqual(readProfileRegistry(f.root).profiles, []);
  assert.equal(legacyDatabasePath(f.root, 'archive-juniper-1976'), null);
  assert.throws(() => openDatabase(), /explicit profile/);
  const missing = join(f.root, 'not-created', 'database.sqlite');
  assert.throws(() => f.open(missing), /existing regular file/);
  assert.equal(existsSync(dirname(missing)), false);
});

test('existing owner derivation is read-only before opening; unowned and mismatched databases never acquire an arbitrary owner', (t) => {
  const f = fixture(t),
    path = join(f.root, 'owned.sqlite');
  const db = f.open(path, 'archive-juniper-1976');
  db.close();
  assert.equal(readDatabaseOwner(path), 'archive-juniper-1976');
  assert.equal(
    f.open(path).prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()!.value,
    'archive-juniper-1976',
  );
  const before = readFileSync(path);
  assert.throws(() => f.open(path, 'archive-elm-1982'), /different profile/);
  assert.deepEqual(readFileSync(path), before);
  const unowned = join(f.root, 'unowned.sqlite'),
    raw = new DatabaseSync(unowned);
  raw.exec('CREATE TABLE app_meta(key TEXT PRIMARY KEY,value TEXT)');
  raw.close();
  const unownedBefore = readFileSync(unowned);
  assert.throws(() => f.open(unowned), /no verified profile owner/);
  assert.throws(() => f.open(unowned, 'archive-juniper-1976'), /no verified profile owner/);
  assert.deepEqual(readFileSync(unowned), unownedBefore);
});

test('generic legacy locations retain their exact metadata owner and registry selection rejects wrong, traversal and linked databases', (t) => {
  const f = fixture(t),
    id = 'archive-juniper-1976',
    path = join(f.root, 'data/database.sqlite');
  f.open(path, id);
  const discovered = readProfileRegistry(f.root);
  assert.deepEqual(discovered.profiles, [
    { id, placebo: false, legacyDatabase: 'data/database.sqlite' },
  ]);
  writeProfileRegistry(f.root, discovered.profiles);
  assert.equal(existingProfileDatabase(f.root, id), path);
  assert.equal(legacyDatabasePath(f.root, 'archive-elm-1982'), null);
  writeProfileRegistry(f.root, [
    { id: 'archive-elm-1982', placebo: false, legacyDatabase: 'data/database.sqlite' },
  ]);
  assert.throws(() => legacyDatabasePath(f.root, 'archive-elm-1982'), /different profile/);
  assert.throws(
    () =>
      writeProfileRegistry(f.root, [
        { id, placebo: false, legacyDatabase: 'data/../outside.sqlite' },
      ]),
    /Invalid profile registry/,
  );
  const linked = join(f.root, 'data/linked.sqlite');
  symlinkSync(path, linked);
  writeProfileRegistry(f.root, [{ id, placebo: false, legacyDatabase: 'data/linked.sqlite' }]);
  assert.throws(() => legacyDatabasePath(f.root, id), /symbolic links/);
});

test('legacy providers and attachments require exact selected-owner references and hashes, without blanket provider access', (t) => {
  const f = fixture(t),
    id = 'archive-juniper-1976',
    other = 'archive-elm-1982';
  const db = f.open(join(f.root, 'data/database.sqlite'), id);
  const ownPath = 'providers/invented-lab/result.json',
    bytes = original(f.root, db, ownPath, 'fictional result <0.0030');
  original(f.root, db, `data/attachments/${id}/retained.json`, 'fictional attachment');
  const otherDb = f.open(ensureProfileDirectories(f.root, other).database, other);
  const foreignPath = `providers/${other}/result.json`;
  original(f.root, otherDb, foreignPath, 'other fictional owner');
  writeProfileRegistry(f.root, [
    { id, placebo: false, legacyDatabase: 'data/database.sqlite' },
    { id: other, placebo: false },
  ]);
  assert.deepEqual(readFileSync(profileFile(f.root, ownPath, id)), bytes);
  assert.throws(() => profileFile(f.root, ownPath, other), { code: 'PROFILE_BOUNDARY' });
  assert.throws(() => profileFile(f.root, foreignPath, id), { code: 'PROFILE_BOUNDARY' });
  writeFileSync(join(f.root, 'providers/invented-lab/unindexed.json'), bytes);
  assert.throws(() => profileFile(f.root, 'providers/invented-lab/unindexed.json', id), {
    code: 'PROFILE_BOUNDARY',
  });
  writeFileSync(join(f.root, ownPath), Buffer.alloc(bytes.length, 42));
  assert.throws(() => profileFile(f.root, ownPath, id), { code: 'ASSET_INTEGRITY' });
  writeFileSync(join(f.root, ownPath), bytes);
  assert.throws(() => profileFile(f.root, ownPath, id, otherDb), { code: 'PROFILE_BOUNDARY' });
});

test('arbitrary legacy archive ID and original default path survive backup/restore with owner verification before files', async (t) => {
  const f = fixture(t),
    id = 'archive-juniper-1976',
    path = join(f.root, 'data/database.sqlite');
  const db = f.open(path, id),
    source = 'providers/invented-lab/result.json';
  const bytes = original(f.root, db, source, 'fictional exact spelling +0004.500');
  const receipt = await createBackup(db, f.root, id),
    target = join(f.root, 'restored');
  restoreBackup(receipt.path, target);
  assert.equal(existingProfileDatabase(target, id), join(target, 'data/database.sqlite'));
  assert.equal(readProfileRegistry(target).profiles[0]!.id, id);
  assert.deepEqual(readFileSync(profileFile(target, source, id)), bytes);
  assert.equal(readDatabaseOwner(existingProfileDatabase(target, id)), id);
  const manifestPath = join(receipt.path, 'manifest.json'),
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.databasePath;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const oldTarget = join(f.root, 'old-writer-restored');
  restoreBackup(receipt.path, oldTarget);
  assert.equal(readDatabaseOwner(existingProfileDatabase(oldTarget, id)), id);
  manifest.profileId = 'archive-elm-1982';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => restoreBackup(receipt.path, join(f.root, 'bad-restore')), /profile mismatch/);
  assert.equal(existsSync(join(f.root, 'bad-restore')), false);
});

test('registry-free discovery and rebuild survive cache loss using verified durable owner metadata, never renamed identities', (t) => {
  const f = fixture(t),
    id = 'archive-juniper-1976',
    paths = ensureProfileDirectories(f.root, id),
    db = f.open(paths.database, id);
  const path = paths.relativeRoot + '/sources/fictional.json';
  original(f.root, db, path, 'fictional durable original');
  attachPersonalDurability(db, { root: f.root, profileId: id });
  exportCuration(db, f.root, id);
  db.close();
  rmSync(paths.databaseDirectory, { recursive: true });
  assert.equal(readProfileRegistry(f.root).profiles[0]!.id, id);
  const rebuilt = rebuildProfile(f.root, id, join(f.root, 'rebuilt'));
  const recovered = f.open(rebuilt.database);
  assert.equal(
    recovered.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()!.value,
    id,
  );
  assert.equal(recovered.prepare('SELECT count(*) n FROM source_records').get()!.n, 1);
  const wrong = ensureProfileDirectories(f.root, 'archive-elm-1982');
  const db2 = f.open(wrong.database, id);
  db2.close();
  assert.throws(() => readProfileRegistry(f.root), /directory owner mismatch/);
});
