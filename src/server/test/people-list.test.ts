import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase } from '../database.ts';
import { createNote, getNote, listNotes } from '../notes.ts';
import { setVisibility } from '../visibility.ts';

test('People excludes canonical Self before pagination and totals without affecting other readers or life status', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'health-people-list-'));
  const db = openDatabase(resolve(root, 'test.sqlite'), 'cookie-dough');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const self = getNote(db, 'patient');
  const a = createNote(db, {
    kind: 'person',
    title: 'Fictional living contact',
    person: { lifeStatus: 'alive' },
  });
  const b = createNote(db, {
    kind: 'person',
    title: 'Fictional deceased contact',
    person: { lifeStatus: 'deceased' },
  });
  const query = (extra: Record<string, string> = {}) =>
    listNotes(db, new URLSearchParams({ kind: 'person', excludeSelf: '1', ...extra }));
  db.prepare('UPDATE notes SET pinned=1 WHERE id=?').run(self.id);
  assert.equal(query().total, 2);
  assert.equal(query({ limit: '1' }).data.length, 1);
  assert.equal(query({ limit: '1', offset: '1' }).data.length, 1);
  assert.ok(query().data.every((row) => !row.isSelf));
  assert.equal(query({ q: self.title }).total, 0);
  assert.equal(listNotes(db, new URLSearchParams({ kind: 'person' })).total, 3);
  assert.equal(getNote(db, 'patient').id, self.id);
  const filter = JSON.stringify([{ field: 'lifeStatus', operator: 'any', values: ['alive'] }]);
  assert.deepEqual(
    query({ filters: filter }).data.map((row) => row.id),
    [a.id],
  );
  assert.ok(a.personId);
  setVisibility(db, 'person', a.personId, { archived: true, version: 0 });
  assert.deepEqual(
    query().data.map((row) => row.id),
    [b.id],
  );
  assert.deepEqual(
    query({ visibility: 'archived', filters: filter }).data.map((row) => row.id),
    [a.id],
  );
  assert.equal(query({ visibility: 'all' }).total, 2);
});
