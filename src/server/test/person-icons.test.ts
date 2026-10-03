import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase } from '../database.ts';
import { getNote, saveNote, createNote, selfIdentity } from '../notes.ts';
import { attachPersonalDurability, exportCuration, rebuildProfile } from '../portable.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import { restoreNoteFields, previewNoteRestoration } from '../note-history.ts';
import { validPersonIcon } from '../../shared/person-icon.ts';
import { randomUUID } from 'node:crypto';
import { resolveAssistantPage } from '../assistant-context.ts';
import type { Note } from '../../shared/api.ts';

test('person symbols and single emoji accept joined emoji but reject markup, URLs and prose', () => {
  for (const icon of ['', 'star', 'stethoscope', '🃏', '🏳️‍⚧️', '👩🏽‍⚕️', '🇺🇸'])
    assert.ok(validPersonIcon(icon), icon);
  for (const icon of ['<svg/>', 'https://example.com/icon.png', 'hello', '🌙🌙', 1, {}])
    assert.equal(validPersonIcon(icon), false);
});
test('Self icon publishes versioned identity, restores append-only and survives a database rebuild', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'health-person-icons-')),
    profileId = 'cookie-dough';
  const paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  attachPersonalDurability(db, { root, profileId });
  let self: Note = getNote(db, 'patient');
  self = saveNote(db, self.id, { ...self, person: { ...self.person, icon: 'moon' } });
  const baseline = String(
    db
      .prepare(
        "SELECT version_id FROM __record_versions WHERE entity='notes' AND record_id=? ORDER BY sequence DESC LIMIT 1",
      )
      .get(JSON.stringify([self.id]))!.version_id,
  );
  self = saveNote(db, self.id, { ...self, person: { ...self.person, icon: '🃏' } });
  assert.equal(selfIdentity(db).icon, '🃏');
  assert.equal(selfIdentity(db).nameVersion, self.version);
  const restored = restoreNoteFields(db, root, profileId, self.id, {
    ...previewNoteRestoration(db, root, profileId, self.id, {
      generationId: baseline,
      fields: ['person.icon'],
      version: self.version,
      operationId: randomUUID(),
    }),
    generationId: baseline,
    fields: ['person.icon'],
    version: self.version,
    operationId: randomUUID(),
  });
  assert.equal(restored.note.person.icon, 'moon');
  assert.ok(restored.note.version > self.version);
  const person: Note = createNote(db, {
    kind: 'person',
    title: 'Fictional friend',
    person: { icon: 'cat', futureField: 'keep' },
  });
  assert.throws(
    () => saveNote(db, person.id, { ...person, person: { ...person.person, icon: '<script>' } }),
    /single emoji/,
  );
  exportCuration(db, root, profileId);
  const output = resolve(root, 'rebuilt');
  rebuildProfile(root, profileId, output);
  const rebuilt = openDatabase(profilePaths(output, profileId).database, profileId);
  try {
    assert.equal(selfIdentity(rebuilt).icon, 'moon');
    assert.equal(getNote(rebuilt, person.id).person.icon, 'cat');
    assert.equal(getNote(rebuilt, person.id).person.futureField, 'keep');
  } finally {
    rebuilt.close();
  }
  const page = resolveAssistantPage(
    db,
    { route: '#/', selection: { collection: 'results', id: 'stale-selection' } },
    (selection) => getNote(db, selection.id),
  );
  assert.ok('name' in page);
  assert.equal(page.name, self.title);
  assert.equal(page.selected?.collection, 'people');
  assert.equal(page.selected?.id, 'patient');
});

test('new people get durable varied defaults and cannot share a display name and icon', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'health-person-defaults-'));
  const db = openDatabase(resolve(root, 'test.sqlite'), 'fictional');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const input = { id: `note:${randomUUID()}`, kind: 'person', title: 'Cookie Doe' };
  const first = createNote(db, input);
  assert.ok(first.person.icon?.startsWith('lucide:'));
  assert.equal(
    createNote(db, input).person.icon,
    first.person.icon,
    'retry preserves random selection',
  );
  const second = createNote(db, { kind: 'person', title: 'Cookie Doe' });
  assert.notEqual(second.person.icon, first.person.icon, 'same-name defaults cannot collide');
  assert.throws(
    () =>
      createNote(db, {
        kind: 'person',
        title: ' cookie   DOE ',
        person: { icon: first.person.icon },
      }),
    /display name and icon/,
  );
  assert.throws(
    () =>
      saveNote(db, second.id, { ...second, person: { ...second.person, icon: first.person.icon } }),
    /display name and icon/,
  );
  assert.equal(getNote(db, second.id).person.icon, second.person.icon, 'failed save is atomic');
  const third = createNote(db, { kind: 'person', title: 'Another Doe', person: { icon: 'star' } });
  assert.throws(
    () => createNote(db, { kind: 'person', title: third.title, person: { icon: 'lucide:star' } }),
    /display name and icon/,
  );
  createNote(db, { kind: 'person', title: 'Cookie Alarm', person: { icon: 'lucide:alarm-check' } });
  assert.throws(
    () =>
      createNote(db, {
        kind: 'person',
        title: 'COOKIE ALARM',
        person: { icon: 'lucide:alarm-clock-check' },
      }),
    /display name and icon/,
  );
  const self = getNote(db, 'patient');
  assert.throws(
    () =>
      saveNote(db, self.id, {
        ...self,
        person: { ...self.person, name: third.title, icon: 'star' },
      }),
    /display name and icon/,
  );
});
