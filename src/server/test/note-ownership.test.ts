import { clinicalPeople } from '../queries.ts';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, type Database } from '../database.ts';
import {
  createNote,
  saveNote,
  getNote,
  listNotes,
  finishNote,
  correctionNote,
  convertNote,
} from '../notes.ts';
import { historicalNotes } from '../historical-notes.ts';
import { recordOwner } from '../record-owner.ts';
import {
  assistantPersonScope,
  scopeAssistantQuery,
  assertAssistantRecordOwner,
} from '../assistant-person-scope.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability, exportCuration, rebuildProfile } from '../portable.ts';
import { exportOptions, exportSnapshot } from '../note-exports.ts';
function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'fictional-note-owner-'));
  const rebuiltRoot = root + '-rebuilt';
  const paths = ensureProfileDirectories(root, 'cookie-dough');
  const db = openDatabase(paths.database, 'cookie-dough');
  const opened: Database[] = [db];
  t.after(() => {
    for (const connection of opened) connection.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(rebuiltRoot, { recursive: true, force: true });
  });
  const person = createNote(db, {
    kind: 'person',
    title: 'Cookie Doe',
    person: { birthDate: '1986-02-14' },
  });
  const owner = person.personId!;
  const self = createNote(db, {
    kind: 'note',
    title: 'Self only',
    content: 'Self private context',
  });
  const other = createNote(db, {
    kind: 'note',
    title: 'Cookie context',
    content: 'Cookie private context',
    ownerPersonId: owner,
  });
  return { root, rebuiltRoot, db, opened, owner, person, self, other };
}
test('authored notes have explicit immutable owners; links and old clients cannot change them', (t) => {
  const { db, owner, person, self, other } = fixture(t);
  assert.equal(other.personId, null);
  assert.equal(other.ownerPersonId, owner);
  assert.deepEqual(
    listNotes(db, new URLSearchParams({ kind: 'note' })).data.map((n) => n.id),
    [self.id],
  );
  assert.deepEqual(
    listNotes(db, new URLSearchParams({ kind: 'note', personId: owner })).data.map((n) => n.id),
    [other.id],
  );
  const linked = saveNote(db, self.id, {
    version: self.version,
    links: [{ targetType: 'person', targetId: person.personId }],
  });
  assert.equal(linked.ownerPersonId, 'patient');
  const saved = saveNote(db, other.id, {
    version: other.version,
    content: 'Updated',
    person: { recordOwnerPersonId: 'patient' },
  });
  assert.equal(saved.ownerPersonId, owner);
  assert.throws(
    () => saveNote(db, other.id, { version: saved.version, ownerPersonId: 'patient' }),
    /cannot reassign/,
  );
  assert.throws(
    () => createNote(db, { title: 'Wrong archive', content: '', ownerPersonId: 'missing-person' }),
    /does not exist/,
  );
});
test('legacy metadata absence remains Self without rewriting existing stored contents', (t) => {
  const { db, self } = fixture(t);
  db.prepare("UPDATE notes SET profile_json='{}' WHERE id=?").run(self.id);
  assert.equal(getNote(db, self.id).ownerPersonId, 'patient');
  assert.equal(
    db.prepare('SELECT profile_json FROM notes WHERE id=?').get(self.id)?.profile_json,
    '{}',
  );
  saveNote(db, self.id, { version: self.version, content: 'A new edit' });
  assert.equal(
    db.prepare('SELECT profile_json FROM notes WHERE id=?').get(self.id)?.profile_json,
    '{}',
  );
});
test('conversion, finished history, corrections and source-only rebuild retain the owner', (t) => {
  const { db, other, owner, root, rebuiltRoot, opened } = fixture(t);
  const converted = convertNote(db, other.id, {
    version: other.version,
    typeLabel: 'Visit',
    eventDate: '2026-09-28',
  });
  const finished = finishNote(db, other.id, {
    version: converted.version,
    title: converted.title,
    content: converted.content,
    links: [],
  });
  attachPersonalDurability(db, { root, profileId: 'cookie-dough' });
  exportCuration(db, root, 'cookie-dough');
  const correction = correctionNote(db, finished.id, {});
  assert.equal(correction.ownerPersonId, owner);
  assert.equal(historicalNotes(db, new URLSearchParams()).data.length, 0);
  assert.equal(historicalNotes(db, new URLSearchParams({ personId: owner })).data.length, 2);
  exportCuration(db, root, 'cookie-dough');
  const receipt = rebuildProfile(root, 'cookie-dough', rebuiltRoot);
  const rebuilt = openDatabase(receipt.database, 'cookie-dough');
  opened.push(rebuilt);
  assert.equal(getNote(rebuilt, other.id).ownerPersonId, owner);
  assert.equal(getNote(rebuilt, correction.id).ownerPersonId, owner);
  assert.equal(getNote(rebuilt, other.id).status, 'finished');
});
test('record links and assistant queries use saved ownership, not a conflicting URL filter', (t) => {
  const { db, owner, other, self } = fixture(t);
  assert.equal(recordOwner(db, 'note', other.id), owner);
  const context = { route: `/notes?id=${encodeURIComponent(other.id)}&personId=patient` };
  assert.equal(assistantPersonScope(db, context), owner);
  assert.deepEqual(scopeAssistantQuery({ collection: 'notes' }, owner), {
    collection: 'notes',
    personId: owner,
  });
  assert.throws(
    () => scopeAssistantQuery({ collection: 'results', personId: 'patient' }, owner),
    /other person/,
  );
  assert.throws(
    () => assertAssistantRecordOwner(db, { collection: 'notes', id: self.id }, owner),
    /different person/,
  );
  assertAssistantRecordOwner(db, { collection: 'notes', id: other.id }, owner);
  assert.equal(assistantPersonScope(db, { route: '/sources' }), null);
});
test('family note exports use their subject, omit Self notes, and reject mixed clinical selection', (t) => {
  const { db, owner, self, other } = fixture(t);
  const options = exportOptions(db, { type: 'note', id: other.id });
  assert.equal(
    options.choices.some((row) => row.id === self.id),
    false,
  );
  const input = {
    type: 'note',
    id: other.id,
    noteVersion: other.version,
    mode: 'brief',
    selected: [],
  };
  assert.throws(
    () => exportSnapshot(db, { ...input, selected: [`note:${self.id}`] }),
    /only its selected person/,
  );
  const snapshot = exportSnapshot(db, input);
  assert.equal(snapshot.identity.name, 'Cookie Doe');
  assert.equal(JSON.stringify(snapshot).includes('Self private context'), false);
  assert.equal(snapshot.main.note?.ownerPersonId, owner);
});

test('a family provider packet contains that person’s clinical rows and cannot include Self results', (t) => {
  const { db, owner, other } = fixture(t);
  db.exec(
    "INSERT INTO source_files(id,path,sha256,bytes) VALUES('fictional-file','fictional.json','fictional',1); INSERT INTO source_records(id,source_file_id,raw_json) VALUES('fictional-raw','fictional-file','{}'); INSERT INTO test_types(id,label) VALUES('fictional-test','Fictional count')",
  );
  for (const [id, personId, value] of [
    ['self-result', 'patient', '10'],
    ['cookie-result', owner, '20'],
  ]) {
    db.prepare(
      "INSERT INTO observations(id,test_type_id,person_id,source_record_id,label,value_text,effective_at) VALUES(?,'fictional-test',?,'fictional-raw','Fictional count',?,'2026-09-28')",
    ).run(id, personId, value);
  }
  const input = {
    type: 'note',
    id: other.id,
    noteVersion: other.version,
    mode: 'provider',
    selected: [],
  };
  const packet = exportSnapshot(db, input);
  const printed = JSON.stringify(packet);
  assert.equal(packet.identity.name, 'Cookie Doe');
  assert.equal(printed.includes('cookie-result'), true);
  assert.equal(printed.includes('self-result'), false);
});

test('person dropdown options are complete beyond a notes page and exclude Self and archived people', (t) => {
  const { db, person } = fixture(t);
  for (let i = 0; i < 55; i++) createNote(db, { kind: 'person', title: 'Fictional person ' + i });
  const inactive = createNote(db, { kind: 'person', title: 'Fictional inactive', archived: true });
  const options = clinicalPeople(db);
  assert.equal(options.length, 56);
  assert.equal(
    options.some((p) => p.personId === 'patient' || p.noteId === inactive.id),
    false,
  );
  assert.ok(options.some((p) => p.noteId === person.id && p.personId === person.personId));
  assert.deepEqual(Object.keys(options[0]!).sort(), [
    'birthDate',
    'icon',
    'name',
    'noteId',
    'personId',
  ]);
});
