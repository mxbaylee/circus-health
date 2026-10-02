import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, type Database } from '../database.ts';
import { PROFILE_IDS, PROFILES } from '../profiles.ts';
import { writeProfileRegistry } from '../profile-registry.ts';
import {
  profilePaths,
  ensureProfileDirectories,
  existingProfileDatabase,
  legacyDatabasePath,
  profileOriginal,
} from '../profile-storage.ts';
import { createApp } from '../index.ts';
import { createNote, getNote } from '../notes.ts';
import { hash, profileFile } from '../assets.ts';
import { createBackup, restoreBackup } from '../recovery.ts';
import { rebuildProfile, attachPersonalDurability, exportCuration } from '../portable.ts';

function fixture(t: TestContext, ids: readonly string[] = ['cedar', 'cookie-dough', 'orchid']) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'health-orchid-')));
  const dbs = new Map<string, Database>(
    ids.map((id) => {
      const paths = ensureProfileDirectories(root, id);
      const db = openDatabase(paths.database, id);
      if (id !== 'cookie-dough')
        db.prepare("UPDATE people SET display_name=? WHERE id='patient'").run(
          id === 'cedar' ? 'Fictional Cedar' : 'Fictional Orchid',
        );
      return [id, db];
    }),
  );
  writeProfileRegistry(
    root,
    ids.map((id) => ({ id, placebo: id === 'cookie-dough' })),
  );
  t.after(() => {
    for (const db of dbs.values()) {
      try {
        db.close();
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, dbs };
}
function source(root: string, db: Database, id: string) {
  const path = `${profilePaths(root, id).relativeRoot}/sources/provider/result.json`;
  mkdirSync(resolve(root, `data/profiles/${id}/sources/provider`), { recursive: true });
  const raw = JSON.stringify({ value: id });
  writeFileSync(resolve(root, path), raw);
  db.prepare(
    "INSERT INTO source_files(id,path,sha256,bytes,mime_type) VALUES('same-file',?,?,?,'application/json')",
  ).run(path, hash(Buffer.from(raw)), Buffer.byteLength(raw));
  db.prepare(
    "INSERT INTO source_records(id,source_file_id,raw_json) VALUES('same-record','same-file',?)",
  ).run(raw);
  return { path, raw };
}

test('Fictional Orchid is an explicit private profile with its own Self and no legacy fallback', (t) => {
  const { root, dbs } = fixture(t);
  assert.deepEqual(PROFILE_IDS, ['cookie-dough']);
  assert.deepEqual(
    PROFILES.find((p) => p.id === 'orchid'),
    undefined,
  );
  assert.equal(getNote(dbs.get('orchid')!, 'patient').person.name, 'Fictional Orchid');
  assert.equal(
    dbs.get('orchid')!.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get()
      ?.value,
    'orchid',
  );
  assert.throws(
    () => openDatabase(profilePaths(root, 'orchid').database, 'cedar'),
    /different profile/,
  );
  assert.throws(() => profilePaths(root, '../unregistered'), /Unknown profile/);
  assert.equal(legacyDatabasePath(root, 'orchid'), null);
  assert.equal(existingProfileDatabase(root, 'orchid'), profilePaths(root, 'orchid').database);
  dbs.get('orchid')!.close();
  rmSync(profilePaths(root, 'orchid').database);
  writeFileSync(
    resolve(root, 'data/profiles/cookie-dough.sqlite'),
    'must never be opened for another owner',
  );
  const cedarBefore = readFileSync(profilePaths(root, 'cedar').database);
  assert.throws(() => existingProfileDatabase(root, 'orchid'), /database is missing/);
  assert.throws(() => createApp({ root }), /Missing orchid database/);
  assert.equal(existsSync(profilePaths(root, 'orchid').database), false);
  assert.equal(existsSync(resolve(profilePaths(root, 'cedar').personal, 'current.json')), false);
  assert.deepEqual(readFileSync(profilePaths(root, 'cedar').database), cedarBefore);
});

test('HTTP Fictional Orchid reads and writes stay scoped even when copied IDs match another profile', async (t) => {
  const { root, dbs } = fixture(t);
  const files = new Map<string, { path: string; raw: string }>();
  for (const [id, db] of dbs) {
    createNote(db, {
      id: 'note:11111111-1111-4111-8111-111111111111',
      title: id,
      content: `${id} private content`,
    });
    files.set(id, source(root, db, id));
  }
  createNote(dbs.get('cedar')!, {
    id: 'note:22222222-2222-4222-8222-222222222222',
    title: 'Only in the original',
  });
  const app = createApp({ root, databases: dbs });
  await new Promise<void>((resolveListen) => app.server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>((resolveClose) => app.server.close(() => resolveClose())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;
  const registry = (await (await fetch(base + '/profiles')).json()) as {
    meta: { total: number };
    data: Array<{ id: string; name: string; placebo: boolean }>;
  };
  assert.equal(registry.meta.total, 3);
  assert.deepEqual(
    registry.data.map((p) => [p.id, p.name, p.placebo]),
    [
      ['cedar', 'Fictional Cedar', false],
      ['cookie-dough', 'Cookie Dough', true],
      ['orchid', 'Fictional Orchid', false],
    ],
  );
  for (const id of ['cedar', 'cookie-dough', 'orchid']) {
    const response = await fetch(
      `${base}/profiles/${id}/notes/note:11111111-1111-4111-8111-111111111111`,
    );
    const payload = (await response.json()) as {
      data: { content: string };
      meta: { profile: { id: string } };
    };
    assert.equal(payload.data.content, `${id} private content`);
    assert.equal(payload.meta.profile.id, id);
    assert.equal(
      await (await fetch(`${base}/profiles/${id}/sources/same-file/content`)).text(),
      files.get(id)!.raw,
    );
  }
  assert.equal(
    (await fetch(base + '/profiles/orchid/notes/note:22222222-2222-4222-8222-222222222222')).status,
    404,
  );
  assert.equal((await fetch(base + '/profiles/other/notes')).status, 404);
  const origin = { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' };
  let response = await fetch(
    base + '/profiles/orchid/notes/note:11111111-1111-4111-8111-111111111111',
    {
      method: 'PUT',
      headers: origin,
      body: JSON.stringify({ version: 1, content: 'Playground changed' }),
    },
  );
  assert.equal(response.status, 200);
  assert.equal(
    getNote(dbs.get('cedar')!, 'note:11111111-1111-4111-8111-111111111111').content,
    'cedar private content',
  );
  assert.equal(
    getNote(dbs.get('cookie-dough')!, 'note:11111111-1111-4111-8111-111111111111').content,
    'cookie-dough private content',
  );
  const pdf = Buffer.from('%PDF-1.4\nFictional Orchid playground attachment');
  response = await fetch(base + '/profiles/orchid/assets', {
    method: 'POST',
    headers: {
      Origin: origin.Origin,
      'Content-Type': 'application/pdf',
      'X-Filename': 'playground.pdf',
    },
    body: pdf,
  });
  assert.equal(response.status, 201);
  const uploaded = ((await response.json()) as { data: { id: string; contentUrl: string } }).data;
  assert.match(uploaded.contentUrl, /^\/api\/profiles\/orchid\/assets\//);
  assert.match(
    String(
      dbs.get('orchid')!.prepare('SELECT stored_path FROM assets WHERE id=?').get(uploaded.id)
        ?.stored_path,
    ),
    /^data\/profiles\/orchid\/attachments\//,
  );
  assert.deepEqual(
    Buffer.from(await (await fetch(base.slice(0, -4) + uploaded.contentUrl)).arrayBuffer()),
    pdf,
  );
  for (const id of ['cedar', 'cookie-dough'])
    assert.equal(
      (await fetch(`${base}/profiles/${id}/assets/${encodeURIComponent(uploaded.id)}/content`))
        .status,
      404,
    );
  dbs
    .get('orchid')!
    .prepare("UPDATE source_files SET path=? WHERE id='same-file'")
    .run(files.get('cedar')!.path);
  response = await fetch(base + '/profiles/orchid/sources/same-file/content');
  assert.equal(response.status, 403);
  assert.equal(
    ((await response.json()) as { error: { code: string } }).error.code,
    'PROFILE_BOUNDARY',
  );
  response = await fetch(base + '/profiles/orchid/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 403);
});

test('Fictional Orchid original guards and backup restore reject other profiles while preserving copied IDs', async (t) => {
  const { root, dbs } = fixture(t);
  const own = source(root, dbs.get('orchid')!, 'orchid'),
    other = source(root, dbs.get('cedar')!, 'cedar');
  assert.equal(profileFile(root, own.path, 'orchid'), resolve(root, own.path));
  assert.throws(
    () => profileFile(root, other.path, 'orchid'),
    (e) => e instanceof Error && 'code' in e && e.code === 'PROFILE_BOUNDARY',
  );
  assert.throws(() => profileOriginal(root, own.path, 'cedar'), /outside the selected profile/);
  const link = 'data/profiles/orchid/sources/other.json';
  symlinkSync(resolve(root, other.path), resolve(root, link));
  assert.throws(
    () => profileFile(root, link, 'orchid'),
    (e) => e instanceof Error && 'code' in e && e.code === 'PROFILE_BOUNDARY',
  );
  assert.throws(() => profileOriginal(root, link, 'orchid'), /escaped the selected profile/);
  const receipt = await createBackup(dbs.get('orchid')!, root, 'orchid');
  const manifestPath = resolve(receipt.path, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    format: string;
    profileId: string;
    files: Array<{ path: string; bytes: number; sha256: string }>;
  };
  assert.equal(manifest.format, 'circus-health-backup-v2');
  assert.equal(manifest.profileId, 'orchid');
  assert.ok(manifest.files.every((f) => f.path.startsWith('data/profiles/orchid/')));
  const target = resolve(root, 'restored');
  restoreBackup(receipt.path, target);
  const restored = openDatabase(profilePaths(target, 'orchid').database, 'orchid');
  assert.equal(getNote(restored, 'patient').person.name, 'Fictional Orchid');
  assert.equal(
    restored.prepare("SELECT raw_json FROM source_records WHERE id='same-record'").get()?.raw_json,
    own.raw,
  );
  restored.close();
  const rebuilt = rebuildProfile(
    resolve(receipt.path, 'files'),
    'orchid',
    resolve(root, 'rebuilt'),
  );
  const rebuiltDb = openDatabase(rebuilt.database, 'orchid');
  assert.equal(getNote(rebuiltDb, 'patient').person.name, 'Fictional Orchid');
  rebuiltDb.close();
  const foreign = {
    path: other.path,
    bytes: Buffer.byteLength(other.raw),
    sha256: hash(Buffer.from(other.raw)),
  };
  mkdirSync(resolve(receipt.path, 'files/data/profiles/cedar/sources/provider'), {
    recursive: true,
  });
  writeFileSync(resolve(receipt.path, 'files', other.path), other.raw);
  manifest.files.push(foreign);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(
    () => restoreBackup(receipt.path, resolve(root, 'bad-restore')),
    (e) => e instanceof Error && 'code' in e && e.code === 'PROFILE_BOUNDARY',
  );
  assert.equal(existsSync(resolve(root, 'bad-restore')), false);
});

test('portable recovery internals preserve Fictional Orchid without writing another profile', async (t) => {
  const { root, dbs } = fixture(t, ['orchid']);
  source(root, dbs.get('orchid')!, 'orchid');
  attachPersonalDurability(dbs.get('orchid')!, { root, profileId: 'orchid' });
  exportCuration(dbs.get('orchid')!, root, 'orchid');
  const receipt = await createBackup(dbs.get('orchid')!, root, 'orchid');
  assert.equal(receipt.profileId, 'orchid');
  const rebuilt = rebuildProfile(root, 'orchid', resolve(root, 'internal-rebuild'));
  assert.equal(rebuilt.profileId, 'orchid');
  assert.equal(existsSync(profilePaths(root, 'cedar').database), false);
  assert.equal(existsSync(profilePaths(root, 'cookie-dough').database), false);
});

test('a fictional database-only fixture restores with an explicit owner registry, never the placebo path', async (t) => {
  const { root } = fixture(t, []);
  const detached = openDatabase(resolve(root, 'detached-checkpoint.sqlite'), 'orchid');
  let receipt;
  try {
    receipt = await createBackup(detached, root, 'orchid');
  } finally {
    detached.close();
  }
  assert.equal(
    JSON.parse(readFileSync(resolve(receipt.path, 'manifest.json'), 'utf8')).format,
    'circus-health-backup-v1',
  );
  const target = resolve(root, 'fixture-restored');
  restoreBackup(receipt.path, target);
  const path = existingProfileDatabase(target, 'orchid');
  assert.equal(existsSync(path), true);
  assert.equal(legacyDatabasePath(target, 'cookie-dough'), null);
  const db = openDatabase(path, 'orchid');
  assert.equal(getNote(db, 'patient').person.name, 'Patient');
  db.close();
});
