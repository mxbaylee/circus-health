import { randomUUID } from 'node:crypto';
import { hash, profileFile } from '../assets.ts';
import test, { type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createApp } from '../index.ts';
import { rebuildProfile, exportCuration } from '../portable.ts';
import { openDatabase, transaction, type Database } from '../database.ts';
import { getNote, createNote } from '../notes.ts';
import { readProfileRegistry, recoverProfileDeletions } from '../profile-registry.ts';
import { createProfileLifecycle } from '../profile-lifecycle.ts';
function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-profile-actions-'));
  const databases = new Map<string, Database>();
  const actions = createProfileLifecycle({ root, databases });
  t.after(() => {
    for (const db of databases.values())
      try {
        db.close();
      } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, databases, actions };
}
test('empty registry can create independent Self and rebuild without old SQLite', async (t) => {
  const { root, databases, actions } = fixture(t);
  assert.deepEqual(actions.list(), []);
  const p = await actions.create({
    fullName: 'River Test',
    birthDate: '1982-04-17',
    name: 'River Test',
  });
  assert.match(p.id, /^p-/);
  assert.equal(p.name, 'River Test');
  assert.equal(getNote(databases.get(p.id)!, 'patient').person.name, 'River Test');
  assert.equal(getNote(databases.get(p.id)!, 'patient').person.lifeStatus, 'alive');
  const target = resolve(root, 'restore');
  const r = rebuildProfile(root, p.id, target);
  const db = openDatabase(r.database, p.id);
  assert.equal(getNote(db, 'patient').title, 'River Test');
  db.close();
  await assert.rejects(
    actions.create({ fullName: '   ', birthDate: '1982-04-17', name: '   ' }),
    /display name/,
  );
});
test('private copy retains current notes and original source owner unchanged', async (t) => {
  const { root, databases, actions } = fixture(t);
  const a = await actions.create({
    fullName: 'Original',
    birthDate: '1982-04-17',
    name: 'Original',
  });
  createNote(databases.get(a.id)!, { title: 'Keep this', content: 'Private original words' });
  const file = `data/profiles/${a.id}/sources/provider/record.json`;
  mkdirSync(resolve(root, `data/profiles/${a.id}/sources/provider`), { recursive: true });
  const raw = Buffer.from('{"label":"original evidence"}');
  writeFileSync(resolve(root, file), raw);
  transaction(databases.get(a.id)!, () => {
    databases
      .get(a.id)!
      .prepare("INSERT INTO source_files(id,path,sha256,bytes) VALUES('original',?,?,?)")
      .run(file, hash(raw), raw.length);
    databases
      .get(a.id)!
      .prepare(
        "INSERT INTO source_records(id,source_file_id,raw_json) VALUES('original-record','original',?)",
      )
      .run(raw.toString());
  });
  exportCuration(databases.get(a.id)!, root, a.id);
  const b = await actions.create(
    {
      operationId: randomUUID(),
      fullName: 'Playground',
      birthDate: '1982-04-17',
      name: 'Playground',
    },
    a.id,
  );
  assert.equal(b.placebo, false);
  assert.equal(b.name, 'Playground');
  assert.equal(actions.list().find((p) => p.id === a.id)?.name, 'Original');
  assert.equal(
    Number(
      databases.get(b.id)!.prepare("SELECT count(*) n FROM notes WHERE title='Keep this'").get()?.n,
    ),
    1,
  );
  assert.ok(existsSync(resolve(root, 'data/profiles', b.id, 'mappings/private-copy.json')));
  const cloned = databases
    .get(b.id)!
    .prepare("SELECT path FROM source_files WHERE id='original'")
    .get()?.path;
  assert.equal(typeof cloned, 'string');
  assert.equal(cloned, `data/profiles/${b.id}/sources/provider/record.json`);
  assert.deepEqual(readFileSync(profileFile(root, cloned, b.id)), raw);
  actions.remove(a.id, { confirmationName: 'Original', version: a.version });
  assert.deepEqual(readFileSync(profileFile(root, cloned, b.id)), raw);
  rebuildProfile(root, b.id, resolve(root, 'copy-restore'));
});
test('deletion requires exact current identity/version and preserves independent backups', async (t) => {
  const { root, databases, actions } = fixture(t);
  const a = await actions.create({ fullName: 'River', birthDate: '1982-04-17', name: 'River' });
  await assert.rejects(
    actions.create({ fullName: 'River', birthDate: '1982-04-17', name: 'River' }),
    { code: 'DUPLICATE_PROFILE_DISPLAY' },
  );
  const b = await actions.create({ fullName: 'River', birthDate: '1982-04-17', name: 'River Two' });
  assert.throws(
    () => actions.remove(a.id, { confirmationName: 'river', version: a.version }),
    /current full name/,
  );
  assert.throws(
    () => actions.remove(a.id, { confirmationName: 'River', version: a.version - 1 }),
    /current full name/,
  );
  const path = resolve(root, 'data/backups', a.id);
  mkdirSync(path, { recursive: true });
  writeFileSync(resolve(path, 'retained'), 'original');
  actions.remove(a.id, { confirmationName: 'River', version: a.version });
  assert.ok(!databases.has(a.id));
  assert.ok(!existsSync(resolve(root, 'data/profiles', a.id)));
  assert.ok(existsSync(path));
  assert.ok(databases.has(b.id));
  actions.remove(b.id, { confirmationName: 'River Two', version: b.version });
  assert.deepEqual(actions.list(), []);
});
test('a durable deletion intent resumes on startup', async (t) => {
  const { root, databases, actions } = fixture(t);
  const p = await actions.create({
    fullName: 'Temporary',
    birthDate: '1982-04-17',
    name: 'Temporary',
  });
  databases.get(p.id)!.close();
  databases.delete(p.id);
  const path = resolve(root, 'data/operations/profile-deletions');
  mkdirSync(path, { recursive: true });
  writeFileSync(
    resolve(path, p.id + '.json'),
    JSON.stringify({ format: 'health-profile-deletion-v1', profileId: p.id }),
  );
  recoverProfileDeletions(root);
  assert.deepEqual(readProfileRegistry(root).profiles, []);
  assert.ok(!existsSync(resolve(root, 'data/profiles', p.id)));
});

test('HTTP empty start creates, copies and deletes profiles with origin and version checks', async (t) => {
  const { root, databases } = fixture(t);
  const app = createApp({ root, databases });
  await new Promise<void>((resolveListen) => app.server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => app.close());
  const address = app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}/api/profiles`;
  const send = (path: string, method: string, input: unknown) =>
    fetch(url + path, {
      method,
      headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  const created = await send('', 'POST', {
    name: 'New Patient',
    fullName: 'Fictional New Patient',
    birthDate: '1982-04-17',
  });
  assert.equal(created.status, 201);
  const p = ((await created.json()) as { data: { id: string; version: number } }).data;
  const copied = await send(`/${p.id}/copy`, 'POST', {
    name: 'Private Copy',
    operationId: randomUUID(),
  });
  assert.equal(copied.status, 201);
  const copy = ((await copied.json()) as { data: { id: string; version: number } }).data;
  assert.equal(
    (
      await send(`/${copy.id}`, 'DELETE', {
        confirmationName: 'Private Copy',
        version: copy.version,
      })
    ).status,
    200,
  );
  assert.equal(
    (await send(`/${p.id}`, 'DELETE', { confirmationName: 'New Patient', version: p.version }))
      .status,
    200,
  );
  assert.deepEqual((await (await fetch(url)).json()).data, []);
});
test('closing the app during a copy prevents publication', async (t) => {
  const { root, actions } = fixture(t);
  const p = await actions.create({ fullName: 'Source', birthDate: '1982-04-17', name: 'Source' });
  const copy = actions.create(
    {
      operationId: randomUUID(),
      fullName: 'Never published',
      birthDate: '1982-04-17',
      name: 'Never published',
    },
    p.id,
  );
  actions.close();
  await assert.rejects(copy, /stopped/);
  assert.equal(readProfileRegistry(root).profiles.length, 1);
});
test('busy profiles cannot be removed or copied', async (t) => {
  const { root, databases, actions } = fixture(t);
  const p = await actions.create({ fullName: 'Busy', birthDate: '1982-04-17', name: 'Busy' });
  const busy = createProfileLifecycle({ root, databases, busy: () => true });
  assert.throws(
    () => busy.remove(p.id, { confirmationName: p.name, version: p.version }),
    /current work/,
  );
  await assert.rejects(
    busy.create(
      { operationId: randomUUID(), fullName: 'Copy', birthDate: '1982-04-17', name: 'Copy' },
      p.id,
    ),
    /current work/,
  );
});

test('creating a placebo through lifecycle seeds independently fictional clinical records', async (t) => {
  const { databases, actions } = fixture(t);
  const profile = await actions.create({ name: 'Cookie Dough', placebo: true });
  assert.equal(profile.placebo, true);
  assert.equal(profile.name, 'Cookie Dough');
  const db = databases.get(profile.id);
  assert.ok(Number(db!.prepare('SELECT count(*) n FROM observations').get()?.n) > 10);
  assert.equal(actions.list().find((p) => p.id === profile.id)?.placebo, true);
  const blank = await actions.create({ fullName: 'Empty', birthDate: '1982-04-17', name: 'Empty' });
  assert.equal(
    Number(databases.get(blank.id)!.prepare('SELECT count(*) n FROM observations').get()?.n),
    0,
  );
  await assert.rejects(
    actions.create({ name: 'Not a placebo', placebo: true }, profile.id),
    /private copy cannot become/,
  );
});
