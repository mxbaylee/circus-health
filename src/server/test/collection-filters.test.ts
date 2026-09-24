import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, revision, type Database } from '../database.ts';
import { createNote, listNotes } from '../notes.ts';
import { historicalNotes, historicalNoteOptions } from '../historical-notes.ts';
import { personFilterOptions } from '../collection-filters.ts';
import { createApp } from '../index.ts';
import type { CollectionFilter } from '../../shared/collection-filters.ts';
const U = '__unknown__',
  row = (field: string, operator: string, ...values: string[]): CollectionFilter => ({
    field,
    operator,
    values,
  });
const params = (filters: CollectionFilter[], extra: Record<string, string> = {}) =>
  new URLSearchParams({ filters: JSON.stringify(filters), ...extra });
function fixture(t: TestContext, owner = 'cookie-dough') {
  const root = mkdtempSync(resolve(tmpdir(), 'health-filters-')),
    db = openDatabase(resolve(root, 'test.sqlite'), owner);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, db };
}
function people(db: Database) {
  const a = createNote(db, {
    kind: 'person',
    title: 'Aunt',
    person: { tags: ['Family', 'Emergency Contact'], relationship: 'aunt', lifeStatus: 'alive' },
  });
  const b = createNote(db, {
    kind: 'person',
    title: 'Brother',
    person: { tags: ['Family'], relationship: 'brother', lifeStatus: 'deceased' },
  });
  const c = createNote(db, {
    kind: 'person',
    title: 'Care',
    person: { tags: ['Professional'], relationship: 'therapist' },
  });
  const d = createNote(db, { kind: 'person', title: 'Unique unknown person', person: {} });
  db.exec(
    `UPDATE notes SET profile_json=json_set(profile_json,'$.tags',json('["Family"]')) WHERE person_id='patient'`,
  );
  return { a, b, c, d };
}
const personList = (
  db: Database,
  filters: CollectionFilter[],
  extra: Record<string, string> = {},
) => listNotes(db, params(filters, { kind: 'person', ...extra }));
function records(db: Database) {
  db.exec(
    "INSERT INTO providers VALUES('issuer-a','Issuer A'),('issuer-b','Issuer B'),('capture','Acquisition C'); INSERT INTO source_files(id,provider_id,path,sha256,bytes) VALUES('f','capture','fixture','x',1)",
  );
  const add = (id: string, issuer: string | null, type: string, date: string) => {
    db.prepare(
      "INSERT INTO source_records(id,source_file_id,provider_id,raw_json) VALUES(?,'f','capture','{}')",
    ).run('raw:' + id);
    db.prepare(
      "INSERT INTO documents(id,source_record_id,provider_id,title,effective_at,text_content,extra_json) VALUES(?,?,?,?,?,'literal',?)",
    ).run(
      id,
      'raw:' + id,
      issuer,
      id,
      date,
      JSON.stringify({
        sourceFields: { type: 'Progress Notes' },
        historicalNote: { typeLabel: type },
      }),
    );
  };
  add('a', 'issuer-a', 'Primary care', '2026-08-17T10:00:00Z');
  add('b', 'issuer-b', 'Therapy', '2026-08-17T10:00:00Z');
  add('c', null, 'Primary care', '2026-08');
  createNote(db, {
    kind: 'historical',
    title: 'Personal appointment',
    typeLabel: 'Primary care',
    eventDate: '2026-08-17',
  });
}
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;
test('People OR/AND/all/excludes preserve unknown and Self semantics', (t) => {
  const { db } = fixture(t),
    { a, b, c, d } = people(db);
  assert.deepEqual(
    new Set(personList(db, [row('tags', 'any', 'Family', 'Professional')]).data.map((n) => n.id)),
    new Set([a.id, b.id, c.id]),
  );
  assert.deepEqual(
    personList(db, [row('tags', 'all', 'Family', 'Emergency Contact')]).data.map((n) => n.id),
    [a.id],
  );
  assert.deepEqual(
    personList(db, [row('tags', 'any', 'Family'), row('lifeStatus', 'any', 'alive')]).data.map(
      (n) => n.id,
    ),
    [a.id],
  );
  assert.equal(personList(db, [row('tags', 'none', 'Family')]).total, 3);
  assert.equal(personList(db, [row('tags', 'none', 'Family', U)]).total, 1);
  assert.equal(personList(db, [row('tags', 'any', U)]).total, 2);
  assert.deepEqual(
    personList(db, [
      row('relationship', 'none', 'aunt', 'brother', 'therapist'),
      row('text', 'contains', 'Unique unknown person'),
    ]).data.map((n) => n.id),
    [d.id],
  );
  assert.equal(personList(db, [row('lifeStatus', 'none', 'alive', 'deceased')]).total, 3);
  assert.equal(personList(db, [row('lifeStatus', 'none', 'alive', 'deceased', U)]).total, 0);
});
test('mixed historical source/type/status/date keep attribution and partial date precision', (t) => {
  const { db } = fixture(t);
  records(db);
  const result = historicalNotes(
    db,
    params([
      row('source', 'any', 'issuer-a', 'issuer-b'),
      row('type', 'any', 'Primary care', 'Therapy'),
    ]),
  );
  assert.deepEqual(new Set(result.data.map((n) => n.id)), new Set(['a', 'b']));
  assert.equal(historicalNotes(db, params([row('acquisitionSource', 'any', 'capture')])).total, 3);
  assert.equal(
    historicalNotes(db, params([row('source', 'none', 'issuer-a', 'issuer-b')])).total,
    2,
  );
  assert.equal(
    historicalNotes(db, params([row('source', 'none', 'issuer-a', 'issuer-b', U)])).total,
    1,
  );
  assert.equal(
    historicalNotes(db, params([row('date', 'between', '2026-08-17', '2026-08-17')])).total,
    3,
  );
  assert.equal(
    historicalNotes(
      db,
      params([row('date', 'before', '2026-09-01'), row('status', 'any', 'provider')]),
    ).total,
    2,
  );
  assert.equal(
    historicalNotes(db, params([row('source', 'any', 'personal'), row('status', 'any', 'draft')]))
      .total,
    1,
  );
  assert.ok(historicalNoteOptions(db).acquisitionSources?.some((s) => s.value === 'capture'));
});
test('filtered totals and stable pagination match collection including no matches', (t) => {
  const { db } = fixture(t);
  records(db);
  const filters = [row('type', 'any', 'Primary care', 'Therapy')],
    all = historicalNotes(db, params(filters));
  const pages = [0, 1, 2, 3].flatMap((offset) => {
    const page = historicalNotes(db, params(filters, { limit: '1', offset: String(offset) }));
    assert.equal(page.total, all.total);
    return page.data.map((n) => n.id);
  });
  assert.deepEqual(
    pages,
    all.data.map((n) => n.id),
  );
  assert.equal(new Set(pages).size, all.total);
  assert.equal(historicalNotes(db, params([row('type', 'any', 'Unknown future type')])).total, 0);
});
test('incomplete rows ignored; unsupported or invalid filters fail without writes', (t) => {
  const { db } = fixture(t);
  people(db);
  const before = revision(db);
  assert.equal(personList(db, [row('tags', 'any')]).total, 5);
  for (const filters of [
    [row('tags', 'DROP TABLE', 'Family')],
    [row('status', 'any', 'draft')],
    [row('tags); DROP TABLE notes;--', 'any', 'x')],
  ])
    assert.throws(
      () => personList(db, filters),
      (e) => hasCode(e, 'INVALID_FILTER'),
    );
  assert.throws(
    () => historicalNotes(db, params([row('date', 'before', '2026-02-30')])),
    (e) => hasCode(e, 'INVALID_FILTER'),
  );
  assert.throws(
    () => historicalNotes(db, params([row('date', 'between', '2026-09-01', '2026-08-01')])),
    (e) => hasCode(e, 'INVALID_FILTER'),
  );
  assert.equal(personList(db, [row('text', 'contains', "%' OR 1=1--")]).total, 0);
  assert.equal(revision(db), before);
});
test('HTTP filter options and predicates stay within selected profile', async (t) => {
  const { db, root } = fixture(t, 'cedar'),
    { db: other } = fixture(t, 'cookie-dough');
  people(db);
  createNote(other, {
    kind: 'person',
    title: 'Other',
    person: { tags: ['Unique placebo tag'], relationship: 'placebo-only' },
  });
  const app = createApp({
    root,
    databases: new Map([
      ['cedar', db],
      ['cookie-dough', other],
    ]),
  });
  await new Promise<void>((resolveListen) => app.server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>((resolveClose) => app.server.close(() => resolveClose())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles`,
    options = (await (await fetch(base + '/cookie-dough/person-filter-options')).json()) as {
      data: { tags: Array<{ value: string }>; relationship: Array<{ value: string }> };
    };
  assert.ok(options.data.tags.some((o) => o.value === 'unique placebo tag'));
  assert.ok(!options.data.relationship.some((o) => o.value.toLowerCase() === 'self'));
  assert.ok(!options.data.relationship.some((o) => o.value === 'aunt'));
  const result = (await (
    await fetch(
      base +
        '/cookie-dough/notes?' +
        params([row('relationship', 'any', 'aunt')], { kind: 'person' }),
    )
  ).json()) as { meta: { total: number } };
  assert.equal(result.meta.total, 0);
  assert.equal((await fetch(base + '/cedar/notes?kind=person&filters=bad')).status, 400);
  assert.ok(!personFilterOptions(other).tags.some((o) => o.value === 'Family'));
});
