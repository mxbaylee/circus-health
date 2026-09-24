import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, revision } from '../database.ts';
import { createNote, getNote, saveNote, listNotes, personTags } from '../notes.ts';
import { attachPersonalDurability } from '../portable.ts';
import { noteHistory, restoreNoteFields } from '../note-history.ts';
import { randomUUID } from 'node:crypto';
import { profilePaths } from '../profile-storage.ts';
import { createApp } from '../index.ts';
import type { Note } from '../../shared/api.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-people-tags-'));
  const db = openDatabase(resolve(root, 'people.sqlite'), 'cookie-dough');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, db };
}
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;

test('care tags normalize duplicates and whitespace while retaining personal/source fields and role independence', (t) => {
  const { db } = fixture(t);
  const person = createNote(db, {
    kind: 'person',
    title: 'Dr Example',
    person: {
      name: 'Dr Example',
      fullName: 'Morgan Example',
      pronouns: 'they/them',
      relationship: 'therapist',
      tags: [
        ' professional ',
        'Professional',
        '  Primary   Care Provider ',
        'SUPPORT   TEAM',
        'support team',
      ],
      phone: ' +1 (555) 010-1111 ext 2 ',
      email: ' Clinic+Visits@example.com ',
      schedulingUrl: ' https://example.com/appointments?location=clinic ',
      sourceRelative: { originalLabel: 'verbatim' },
      futureField: { keep: true },
    },
  });
  assert.deepEqual(person.person.tags, ['Primary Care Provider', 'Professional', 'support team']);
  assert.equal(person.person.relationship, 'therapist');
  assert.equal(person.person.fullName, 'Morgan Example');
  assert.equal(person.person.pronouns, 'they/them');
  assert.deepEqual(person.person.sourceRelative, { originalLabel: 'verbatim' });
  assert.deepEqual(person.person.futureField, { keep: true });
  assert.equal(person.person.phone, '+1 (555) 010-1111 ext 2');
  assert.equal(person.person.email, 'Clinic+Visits@example.com');
  assert.equal(person.person.schedulingUrl, 'https://example.com/appointments?location=clinic');
  const untagged = createNote(db, {
    kind: 'person',
    title: 'Parent',
    person: { relationship: 'parent' },
  });
  assert.equal(untagged.person.tags, undefined, 'roles are never inferred from a relationship');
  assert.ok(personTags(db).includes('support team'));
  const updated = saveNote(db, person.id, {
    ...person,
    person: { ...person.person, tags: [], email: '' },
  });
  assert.deepEqual(updated.person.tags, []);
  assert.equal(updated.person.email, '');
  assert.deepEqual(updated.person.futureField, { keep: true });
  assert.ok(!personTags(db).includes('support team'));
});

test('tag filtering composes with search, totals and pagination and treats legacy-tagged Self as untagged', (t) => {
  const { db } = fixture(t);
  const first = createNote(db, {
    kind: 'person',
    title: 'Care One',
    person: { tags: ['Family', 'Emergency Contact'] },
  });
  const second = createNote(db, {
    kind: 'person',
    title: 'Care Two',
    person: { tags: ['family'] },
  });
  createNote(db, { kind: 'person', title: 'Other', person: { tags: ['Professional'] } });
  createNote(db, { kind: 'note', title: 'Unrelated freeform note', person: { tags: ['Family'] } });
  let self = getNote(db, 'patient');
  db.prepare('UPDATE notes SET profile_json=? WHERE id=?').run(
    JSON.stringify({ ...self.person, tags: ['Family', 'legacy self only'] }),
    self.id,
  );
  self = getNote(db, self.id);
  assert.equal(self.isSelf, true);
  assert.equal(self.person.tags, undefined);
  assert.deepEqual(self.links, []);
  assert.ok(!personTags(db).includes('legacy self only'));
  const all = listNotes(db, new URLSearchParams({ tag: ' fAmIlY ', limit: '1' }));
  assert.equal(all.total, 2);
  assert.equal(all.data.length, 1);
  assert.equal(all.complete, false);
  const rest = listNotes(
    db,
    new URLSearchParams({ kind: 'person', tag: 'family', limit: '10', offset: '1' }),
  );
  assert.equal(rest.total, 2);
  assert.equal(rest.data.length, 1);
  assert.deepEqual(
    new Set([...all.data, ...rest.data].map((p) => p.id)),
    new Set([first.id, second.id]),
  );
  const searched = listNotes(
    db,
    new URLSearchParams({ kind: 'person', tag: 'Family', q: 'Care Two' }),
  );
  assert.equal(searched.total, 1);
  assert.equal(searched.data[0]!.id, second.id);
  const emergency = listNotes(
    db,
    new URLSearchParams({ kind: 'person', tag: '  emergency  CONTACT ' }),
  );
  assert.equal(emergency.total, 1);
  assert.equal(emergency.data[0]!.id, first.id);
});

test('invalid contacts/tags and stale changes fail without changing version or stored fields', (t) => {
  const { db } = fixture(t);
  const person = createNote(db, {
    kind: 'person',
    title: 'Contact',
    person: { tags: ['Professional'] },
  });
  const before = revision(db);
  for (const bad of [
    { tags: 'Family' },
    { tags: [3] },
    { tags: ['x'.repeat(81)] },
    { tags: Array.from({ length: 25 }, (_, n) => `tag ${n}`) },
    { phone: {} },
    { email: 'unfinished@' },
    { schedulingUrl: 'javascript:alert(1)' },
    { schedulingUrl: 'file:///tmp/test' },
    { schedulingUrl: 'example.com/scheduling' },
  ]) {
    assert.throws(
      () => saveNote(db, person.id, { ...person, person: { ...person.person, ...bad } }),
      (error) => hasCode(error, 'INVALID_INPUT'),
    );
  }
  assert.equal(revision(db), before);
  assert.deepEqual(getNote(db, person.id).person.tags, ['Professional']);
  const newer = saveNote(db, person.id, {
    ...person,
    person: { ...person.person, tags: ['Professional', 'Emergency Contact'] },
  });
  assert.throws(
    () =>
      saveNote(db, person.id, {
        ...person,
        person: { ...person.person, email: 'late@example.com' },
      }),
    (error) => hasCode(error, 'VERSION_CONFLICT'),
  );
  assert.equal(getNote(db, person.id).version, newer.version);
});

test('person-tags endpoint and filtered notes stay inside the selected profile', async (t) => {
  const { db, root } = fixture(t);
  const real = openDatabase(resolve(root, 'other.sqlite'), 'cedar');
  t.after(() => real.close());
  createNote(db, {
    kind: 'person',
    title: 'Fictional clinic',
    person: { tags: ['fictional clinic'], schedulingUrl: 'https://example.com' },
  });
  createNote(real, {
    kind: 'person',
    title: 'Private clinic',
    person: { tags: ['private contact'] },
  });
  const app = createApp({
    root,
    databases: new Map([
      ['cookie-dough', db],
      ['cedar', real],
    ]),
  });
  await new Promise<void>((resolveListen) => app.server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>((resolveClose) => app.server.close(() => resolveClose())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/cookie-dough`;
  const options = (await (await fetch(base + '/person-tags')).json()) as { data: string[] };
  assert.ok(options.data.includes('Family'));
  assert.ok(options.data.includes('fictional clinic'));
  assert.ok(!options.data.includes('private contact'));
  const filtered = (await (
    await fetch(base + '/notes?kind=person&tag=fictional%20clinic')
  ).json()) as { meta: { total: number }; data: Note[] };
  assert.equal(filtered.meta.total, 1);
  assert.equal(filtered.data[0]!.title, 'Fictional clinic');
  assert.equal(filtered.data[0]!.person.schedulingUrl, 'https://example.com');
});

test('Self rejects tag writes, hides legacy roles and cleans current tags on a save without rewriting history', (t) => {
  const { db, root } = fixture(t);
  const initial = getNote(db, 'patient');
  const legacy = {
    ...initial.person,
    tags: ['Professional', 'old private label'],
    schedulingUrl: 'https://example.com/old',
    futureField: { keep: true },
  };
  db.prepare('UPDATE notes SET profile_json=? WHERE id=?').run(JSON.stringify(legacy), initial.id);
  attachPersonalDurability(db, { root, profileId: 'cookie-dough' });
  const folder = resolve(profilePaths(root, 'cookie-dough').personal, 'snapshots');
  const published = new Map(
    readdirSync(folder).map((name) => [name, readFileSync(resolve(folder, name), 'utf8')]),
  );
  assert.ok([...published.values()].some((text) => text.includes('old private label')));
  const current = getNote(db, 'patient');
  for (const tags of [['Family'], ['custom'], 'Professional', null]) {
    assert.throws(
      () =>
        saveNote(db, current.id, { version: current.version, person: { ...current.person, tags } }),
      (error) => hasCode(error, 'SELF_PROFILE'),
    );
  }
  assert.equal(getNote(db, current.id).version, current.version);
  const saved = saveNote(db, current.id, {
    version: current.version,
    content: 'Updated profile notes',
  });
  assert.equal(saved.person.tags, undefined);
  assert.equal(
    JSON.parse(
      String(db.prepare('SELECT profile_json FROM notes WHERE id=?').get(current.id)?.profile_json),
    ).tags,
    undefined,
  );
  assert.equal(saved.person.schedulingUrl, legacy.schedulingUrl);
  const history = noteHistory(db, root, 'cookie-dough', saved.id);
  type HistoryField = { path: string; previous: { present: boolean }; restorable: boolean };
  const previous = history.entries.find((entry) =>
    (entry.fields as HistoryField[]).some(
      (field) => field.path === 'person.tags' && field.previous.present,
    ),
  );
  assert.ok(previous);
  assert.equal(
    (previous.fields as HistoryField[]).find((field) => field.path === 'person.tags')?.restorable,
    false,
  );
  assert.throws(
    () =>
      restoreNoteFields(db, root, 'cookie-dough', saved.id, {
        operationId: randomUUID(),
        generationId: previous.generationId,
        fields: ['person.tags'],
        version: saved.version,
      }),
    (error) => hasCode(error, 'INVALID_FIELDS'),
  );
  assert.deepEqual(saved.person.futureField, { keep: true });
  for (const [name, original] of published)
    assert.equal(readFileSync(resolve(folder, name), 'utf8'), original);
});

test('removing and restoring scheduling roles preserves the stored scheduling URL through API updates', async (t) => {
  const { db, root } = fixture(t);
  const person = createNote(db, {
    kind: 'person',
    title: 'Doctor Fixture',
    person: {
      tags: ['Professional'],
      schedulingUrl: 'https://example.com/schedule',
      email: 'doctor@example.com',
    },
  });
  const app = createApp({ root, databases: new Map([['cookie-dough', db]]) });
  await new Promise<void>((resolveListen) => app.server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>((resolveClose) => app.server.close(() => resolveClose())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/cookie-dough/notes/`;
  const update = async (note: Note, tags: string[]): Promise<Note> => {
    const response = await fetch(base + encodeURIComponent(note.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
      body: JSON.stringify({ version: note.version, person: { ...note.person, tags } }),
    });
    assert.equal(response.status, 200);
    return ((await response.json()) as { data: Note }).data;
  };
  const hidden = await update(person, ['Family']);
  assert.equal(hidden.person.schedulingUrl, person.person.schedulingUrl);
  const shown = await update(hidden, ['Primary Care Provider']);
  assert.equal(shown.person.schedulingUrl, person.person.schedulingUrl);
  const self = getNote(db, 'patient');
  const rejected = await fetch(base + encodeURIComponent(self.id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
    body: JSON.stringify({ version: self.version, person: { ...self.person, tags: ['Family'] } }),
  });
  assert.equal(rejected.status, 400);
  assert.equal(((await rejected.json()) as { error: { code: string } }).error.code, 'SELF_PROFILE');
});
