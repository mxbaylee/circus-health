import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createEncryptedProfiles } from '../encrypted-profiles.ts';
import { createNote, getNote, saveNote } from '../notes.ts';
function fixture(t: TestContext) {
  const base = mkdtempSync(resolve(tmpdir(), 'circus-profiles-'));
  const dataDirectory = resolve(base, 'data'),
    runtimeDirectory = resolve(base, 'runtime');
  mkdirSync(dataDirectory);
  const manager = createEncryptedProfiles({ dataDirectory, runtimeDirectory });
  t.after(() => {
    manager.close();
    rmSync(base, { recursive: true, force: true });
  });
  return { base, dataDirectory, runtimeDirectory, manager };
}
function opened(manager: ReturnType<typeof createEncryptedProfiles>, profileId: string) {
  const state = manager.opened.get(profileId);
  assert.ok(state);
  return state;
}
test('new profile requires actual recovery verification; edits survive lock and cache loss', async (t) => {
  const { manager, dataDirectory } = fixture(t);
  const setup = manager.begin({
    fullName: 'Fictional River',
    birthDate: '1982-04-17',
    name: 'Fictional River',
    placebo: false,
  });
  assert.equal(manager.list().length, 0);
  await assert.rejects(manager.verify(setup.setupId, { acknowledged: true, recovery: 'wrong' }));
  assert.equal(manager.list().length, 0);
  const p = await manager.verify(setup.setupId, {
    acknowledged: true,
    recovery: setup.recoveryKit,
  });
  assert.equal(p.locked, false);
  const state = opened(manager, p.id),
    self = getNote(state.db, 'patient');
  assert.equal(self.person.fullName, 'Fictional River');
  assert.equal(self.person.birthDate, '1982-04-17');
  assert.equal(self.person.lifeStatus, 'alive');
  const other = createNote(state.db, { kind: 'person', title: 'Fictional Contact', person: {} });
  assert.equal(other.person.lifeStatus, undefined);
  saveNote(state.db, self.id, {
    ...self,
    person: {
      ...self.person,
      birthDate: '1990-03-21',
      knownNames: ['Fictional Former River'],
      lifeStatus: 'unknown',
    },
    version: self.version,
  });
  manager.lock(p.id);
  assert.equal(manager.card(p.id).locked, true);
  const root = resolve(dataDirectory, 'profiles', p.id);
  assert(!readFileSync(resolve(root, 'keyring.json'), 'utf8').includes(setup.recoveryKit.phrase));
  rmSync(resolve(root, 'cache'), { recursive: true, force: true });
  manager.unlock(p.id, setup.recoveryKit);
  assert.equal(getNote(opened(manager, p.id).db, 'patient').person.birthDate, '1990-03-21');
  assert.deepEqual(getNote(opened(manager, p.id).db, 'patient').person.knownNames, [
    'Fictional Former River',
  ]);
  assert.equal(getNote(opened(manager, p.id).db, 'patient').person.lifeStatus, 'unknown');
  manager.lock(p.id);
  manager.unlock(p.id, setup.recoveryKit);
  assert.equal(opened(manager, p.id).metrics.cacheHit, true);
});

test('a new profile receives one blank editable Annual Planning note, while copies preserve notes', async (t) => {
  const { manager } = fixture(t);
  const setup = manager.begin({
      fullName: 'Planning Person',
      birthDate: '1982-04-17',
      name: 'Planning Person',
    }),
    profile = await manager.verify(setup.setupId, {
      acknowledged: true,
      recovery: setup.recoveryKit,
    });
  const notes = opened(manager, profile.id)
    .db.prepare("SELECT title,content,status FROM notes WHERE title='Annual Planning'")
    .all();
  assert.equal(notes.length, 1);
  assert.deepEqual({ ...notes[0] }, { title: 'Annual Planning', content: '', status: 'editable' });
  const copy = manager.begin({ name: 'Planning Copy', copyFrom: profile.id });
  await manager.verify(copy.setupId, { acknowledged: true, recovery: copy.recoveryKit });
  assert.equal(
    Number(
      opened(manager, copy.profileId)
        .db.prepare("SELECT count(*) AS n FROM notes WHERE title='Annual Planning'")
        .get()?.n,
    ),
    1,
  );
});

test('recovery file resumes interrupted setup after restart without reissuing secrets', async (t) => {
  const { manager, dataDirectory, runtimeDirectory } = fixture(t);
  const setup = manager.begin({
    fullName: 'Restart Person',
    birthDate: '1982-04-17',
    name: 'Restart Person',
  });
  manager.close();
  const restarted = createEncryptedProfiles({ dataDirectory, runtimeDirectory });
  t.after(() => restarted.close());
  const resumed = restarted.resume(setup.recoveryKit);
  assert.equal(resumed.active, false);
  assert.equal(resumed.name, 'Restart Person');
  assert.equal(restarted.list().length, 0, 'resuming identity does not activate the profile');
  assert.throws(() => restarted.resume({ ...setup.recoveryKit, phrase: 'wrong recovery' }));
  assert.ok(resumed.setupId);
  const profile = await restarted.verify(resumed.setupId, {
    recovery: setup.recoveryKit,
    acknowledged: true,
  });
  assert.equal(profile.name, 'Restart Person');
  const active = restarted.resume(setup.recoveryKit);
  assert.equal(active.active, true);
  assert.equal(active.name, 'Restart Person');
  restarted.lock(profile.id);
  assert.equal(restarted.unlock(profile.id, setup.recoveryKit).locked, false);
  restarted.close();
});

test('ordinary edits append record versions without rewriting the original-file index', async (t) => {
  const { manager, dataDirectory } = fixture(t);
  const setup = manager.begin({
    fullName: 'History Person',
    birthDate: '1982-04-17',
    name: 'History Person',
  });
  const profile = await manager.verify(setup.setupId, {
    recovery: setup.recoveryKit,
    acknowledged: true,
  });
  const state = opened(manager, profile.id),
    vault = resolve(dataDirectory, 'profiles', profile.id, 'vault');
  const indexBefore = readdirSync(resolve(vault, 'indices')).length;
  const versionsBefore = readdirSync(resolve(vault, 'versions')).length;
  for (let i = 0; i < 12; i++) {
    const self = getNote(state.db, 'patient');
    saveNote(state.db, self.id, {
      ...self,
      person: { ...self.person, pronouns: i % 2 ? 'they/them' : 'she/her' },
      version: self.version,
    });
  }
  assert.equal(readdirSync(resolve(vault, 'indices')).length, indexBefore);
  assert(readdirSync(resolve(vault, 'versions')).length > versionsBefore);
  assert(readFileSync(resolve(vault, 'manifest.enc')).length < 2048);
  manager.lock(profile.id);
  rmSync(resolve(dataDirectory, 'profiles', profile.id, 'cache'), { recursive: true, force: true });
  manager.unlock(profile.id, setup.recoveryKit);
  const db = opened(manager, profile.id).db;
  assert.equal(getNote(db, 'patient').person.pronouns, 'they/them');
  assert(
    Number(
      db.prepare('SELECT count(*) AS n FROM __record_fields WHERE field LIKE ?').get('%pronouns%')
        ?.n,
    ) >= 12,
  );
});

test('private copy has independent recovery and editable projection, and survives cache loss', async (t) => {
  const { manager, dataDirectory } = fixture(t);
  const original = manager.begin({
    fullName: 'Original Person',
    birthDate: '1982-04-17',
    name: 'Original Person',
  });
  const p = await manager.verify(original.setupId, {
    recovery: original.recoveryKit,
    acknowledged: true,
  });
  const old = opened(manager, p.id),
    self = getNote(old.db, 'patient');
  saveNote(old.db, self.id, {
    ...self,
    person: { ...self.person, pronouns: 'they/them', lifeStatus: 'deceased' },
    version: self.version,
  });
  const copy = manager.begin({ name: 'Copy Person', copyFrom: p.id });
  const c = await manager.verify(copy.setupId, { recovery: copy.recoveryKit, acknowledged: true });
  assert.notEqual(copy.recoveryKit.phrase, original.recoveryKit.phrase);
  assert.equal(c.placebo, false);
  assert.equal(getNote(opened(manager, c.id).db, 'patient').person.pronouns, 'they/them');
  assert.equal(getNote(opened(manager, c.id).db, 'patient').person.lifeStatus, 'deceased');
  assert.equal(getNote(old.db, 'patient').title, 'Original Person');
  manager.lock(c.id);
  assert.throws(() => manager.unlock(c.id, original.recoveryKit));
  rmSync(resolve(dataDirectory, 'profiles', c.id, 'cache'), { recursive: true, force: true });
  manager.unlock(c.id, copy.recoveryKit);
  assert.equal(getNote(opened(manager, c.id).db, 'patient').title, 'Copy Person');
  assert.equal(getNote(opened(manager, c.id).db, 'patient').person.lifeStatus, 'deceased');
});

test('new private profiles reject missing or invalid identity before creating archive authority', (t) => {
  const { manager, dataDirectory } = fixture(t);
  const before = readdirSync(dataDirectory, { recursive: true }).sort();
  for (const identity of [
    {},
    { fullName: 'Fictional Fern' },
    { fullName: '', birthDate: '1982-04-17' },
    { fullName: 'Fictional Fern', birthDate: '1982' },
    { fullName: 'Fictional Fern', birthDate: '1982-02-30' },
    { fullName: 'Fictional Fern', birthDate: '9999-01-01' },
  ])
    assert.throws(
      () => manager.begin({ name: 'Friendly label', ...identity }),
      /full name|date of birth/,
    );
  assert.deepEqual(manager.list(), []);
  assert.deepEqual(readdirSync(dataDirectory, { recursive: true }).sort(), before);
});
