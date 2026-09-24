import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, revision, type Database } from '../database.ts';
import { createApp } from '../index.ts';
import { getNote, saveNote, createNote, linkTarget, linkTargets, listNotes } from '../notes.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-self-name-'));
  const paths = new Map(['cedar', 'cookie-dough'].map((id) => [id, resolve(root, id + '.sqlite')]));
  const dbs = new Map<string, Database>(
    [...paths].map(([id, path]) => [id, openDatabase(path, id)]),
  );
  t.after(() => {
    for (const db of dbs.values()) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, dbs, paths };
}

test('legacy Self title projects the patient name without mutating stored notes or source facts', (t) => {
  const { dbs } = fixture(t),
    db = dbs.get('cookie-dough')!;
  db.prepare("UPDATE people SET display_name='Cloud Biscuit' WHERE id='patient'").run();
  const before = db.prepare("SELECT * FROM notes WHERE person_id='patient'").get();
  assert.equal(before?.title, 'Self');
  const self = getNote(db, 'patient');
  assert.equal(self.title, 'Cloud Biscuit');
  assert.equal(self.person.name, 'Cloud Biscuit');
  assert.equal(self.isSelf, true);
  assert.equal(linkTarget(db, 'person', 'patient').title, self.title);
  assert.equal(linkTarget(db, 'note', self.id).title, self.title);
  assert.equal(
    linkTargets(db, new URLSearchParams({ type: 'person' })).find((x) => x.targetId === 'patient')
      ?.title,
    self.title,
  );
  assert.equal(
    listNotes(db, new URLSearchParams({ kind: 'person' })).data.find((x) => x.isSelf)?.title,
    self.title,
  );
  assert.equal(
    listNotes(db, new URLSearchParams({ kind: 'person', q: 'Cloud Biscuit' })).data[0]?.id,
    self.id,
  );
  assert.equal(
    linkTargets(db, new URLSearchParams({ type: 'person', q: 'Cloud Biscuit' }))[0]?.title,
    self.title,
  );
  assert.deepEqual(
    db.prepare("SELECT * FROM notes WHERE person_id='patient'").get(),
    before,
    'read projections never rewrite legacy fields',
  );
});

test('renaming Self preserves stable identity, legal name, pronouns, source fields, and current linked titles', (t) => {
  const { dbs, paths } = fixture(t),
    db = dbs.get('cedar')!;
  const original = getNote(db, 'patient');
  const comment = createNote(db, {
    title: 'Context',
    links: [{ targetType: 'person', targetId: 'patient' }],
  });
  const input = {
    ...original,
    title: 'Older display alias',
    person: {
      ...original.person,
      name: '  Nova  ',
      fullName: 'Example Legal Name',
      pronouns: 'they/she',
      sourceRelative: { originalName: 'Retained verbatim' },
      futureField: { preserved: true },
    },
  };
  const updated = saveNote(db, original.id, input);
  assert.equal(updated.id, original.id);
  assert.equal(updated.personId, 'patient');
  assert.equal(updated.isSelf, true);
  assert.equal(updated.title, 'Nova');
  assert.equal(updated.person.name, 'Nova');
  assert.equal(updated.person.fullName, 'Example Legal Name');
  assert.equal(updated.person.pronouns, 'they/she');
  assert.deepEqual(updated.person.sourceRelative, input.person.sourceRelative);
  assert.deepEqual(updated.person.futureField, { preserved: true });
  assert.equal(
    db.prepare("SELECT display_name FROM people WHERE id='patient'").get()?.display_name,
    'Nova',
  );
  assert.equal(getNote(db, comment.id).links[0]?.title, 'Nova');
  assert.equal(getNote(db, comment.id).links[0]?.id, comment.links[0]?.id);
  assert.equal(getNote(dbs.get('cookie-dough')!, 'patient').person.name, 'Cookie Dough');
  const before = revision(db);
  assert.throws(
    () => saveNote(db, updated.id, { ...updated, person: { ...updated.person, name: ' ' } }),
    (e) => (e as Error & { code?: string }).code === 'INVALID_INPUT',
  );
  assert.throws(
    () => saveNote(db, updated.id, { ...input, person: { ...input.person, name: 'Stale rename' } }),
    (e) => (e as Error & { code?: string }).code === 'VERSION_CONFLICT',
  );
  assert.throws(
    () => saveNote(db, updated.id, { ...updated, archived: true }),
    (e) => (e as Error & { code?: string }).code === 'SELF_PROFILE',
  );
  assert.throws(
    () =>
      saveNote(db, updated.id, {
        ...updated,
        links: [{ targetType: 'note', targetId: comment.id }],
      }),
    (e) => (e as Error & { code?: string }).code === 'SELF_PROFILE',
  );
  assert.equal(revision(db), before);
  assert.equal(getNote(db, 'patient').title, 'Nova');
  // Calling another person "Self" never grants canonical-patient behavior.
  const other = createNote(db, {
    kind: 'person',
    title: 'Self',
    person: { name: 'Self', relationship: 'Self' },
  });
  assert.equal(other.isSelf, false);
  db.close();
  dbs.set('cedar', openDatabase(paths.get('cedar')!, 'cedar'));
  assert.equal(
    getNote(dbs.get('cedar')!, 'patient').person.name,
    'Nova',
    'display name persists across database reopening',
  );
});

test('profile API reflects Self edits immediately and versioned metadata tracks the same name', async (t) => {
  const { root, dbs } = fixture(t);
  const app = createApp({ root, databases: dbs });
  await new Promise<void>((done) => app.server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>((done) => app.server.close(() => done())));
  const address = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}/api`;
  interface ProfileMeta {
    id: string;
    name: string;
    nameVersion: number;
    version: number;
    placebo: boolean;
  }
  const registry = (await (await fetch(base + '/profiles')).json()) as { data: ProfileMeta[] };
  const oldPlacebo = registry.data.find((p) => p.id === 'cookie-dough');
  assert.equal(oldPlacebo?.name, getNote(dbs.get('cookie-dough')!, 'patient').person.name);
  const self = getNote(dbs.get('cookie-dough')!, 'patient');
  const response = await fetch(
    base + '/profiles/cookie-dough/notes/' + encodeURIComponent(self.id),
    {
      method: 'PUT',
      headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...self, person: { ...self.person, name: 'Starlight Cookie' } }),
    },
  );
  assert.equal(response.status, 200);
  const saved = (await response.json()) as {
    data: { title: string; version: number };
    meta: { profile: ProfileMeta };
  };
  assert.equal(saved.data.title, 'Starlight Cookie');
  assert.deepEqual(saved.meta.profile, {
    id: 'cookie-dough',
    placebo: true,
    name: 'Starlight Cookie',
    nameVersion: saved.data.version,
    version: saved.data.version,
  });
  assert.ok(oldPlacebo && saved.meta.profile.nameVersion > oldPlacebo.nameVersion);
  const after = (await (await fetch(base + '/profiles')).json()) as { data: ProfileMeta[] };
  assert.deepEqual(
    after.data.find((p) => p.id === 'cookie-dough'),
    { ...saved.meta.profile, version: saved.data.version },
  );
  assert.deepEqual(
    after.data.find((p) => p.id === 'cedar'),
    registry.data.find((p) => p.id === 'cedar'),
  );
});
