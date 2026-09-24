import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { createNote, finishNote, getNote, linkTarget, listNotes, saveNote } from '../notes.ts';
import { setVisibility, visibilityState } from '../visibility.ts';
import {
  clinicalList,
  setMedicationCurrentStatus,
  trends,
  observations,
  sourceFiles,
  sourceRecords,
  getSourceRecord,
} from '../queries.ts';
import { historicalNotes, getHistoricalNote } from '../historical-notes.ts';
import { createApp } from '../index.ts';
import { attachPersonalDurability, exportCuration, rebuildProfile } from '../portable.ts';
import { hash } from '../assets.ts';
function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'visibility-fixture-')),
    paths = ensureProfileDirectories(root, 'cedar'),
    db = openDatabase(paths.database, 'cedar');
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const bytes = Buffer.from('{}'),
    path = paths.relativeRoot + '/sources/fixture.json';
  writeFileSync(resolve(root, path), bytes);
  db.prepare("INSERT INTO source_files(id,path,sha256,bytes) VALUES('same',?,?,?)").run(
    path,
    hash(bytes),
    bytes.length,
  );
  db.exec(
    "INSERT INTO source_records(id,source_file_id,raw_json) VALUES('same','same','{}'); INSERT INTO medications(id,source_record_id,kind,label,status) VALUES('med','same','order','Example prescription','active'); INSERT INTO test_types(id,label,category) VALUES('test','Example measurement','lab'); INSERT INTO observations(id,source_record_id,test_type_id,label,effective_at,value_text,value_numeric) VALUES('result','same','test','Example result','2026-01-01','1',1)",
  );
  return { root, paths, db };
}
const params = (x: Record<string, string> = {}) => new URLSearchParams(x);
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;
test('finished note visibility adds retained events without changing frozen content, versions, or stable links', (t) => {
  const { db } = fixture(t);
  const draft = createNote(db, {
    kind: 'historical',
    title: 'Visit',
    content: 'Original frozen content',
  });
  const note = finishNote(db, draft.id, { ...draft });
  const linked = createNote(db, {
    title: 'Context',
    content: 'See original',
    links: [{ targetType: 'note', targetId: note.id }],
  });
  const frozen = db.prepare('SELECT * FROM notes WHERE id=?').get(note.id);
  setVisibility(db, 'note', note.id, { archived: true, version: 0 });
  assert.equal(historicalNotes(db, params()).total, 0);
  assert.equal(historicalNotes(db, params({ visibility: 'archived' })).total, 1);
  assert.equal(getHistoricalNote(db, note.id).archived, true);
  assert.equal(getNote(db, linked.id).links[0]!.archived, true);
  assert.deepEqual(db.prepare('SELECT * FROM notes WHERE id=?').get(note.id), frozen);
  assert.throws(
    () => setVisibility(db, 'note', note.id, { archived: false, version: 0 }),
    (e) => hasCode(e, 'VERSION_CONFLICT'),
  );
  setVisibility(db, 'note', note.id, { archived: false, version: 1 });
  assert.equal(getNote(db, linked.id).links[0]!.archived, false);
  assert.equal(visibilityState(db, 'note', note.id).history.length, 2);
  assert.throws(() => db.exec('DELETE FROM visibility_events'), /append-only/);
  assert.throws(() => db.exec('UPDATE visibility_events SET archived=0'), /append-only/);
  assert.deepEqual(db.prepare('SELECT * FROM notes WHERE id=?').get(note.id), frozen);
});
test('Self aliases are protected; people aliases share visibility and legacy restores become new events', (t) => {
  const { db } = fixture(t);
  const self = db.prepare("SELECT id FROM notes WHERE person_id='patient'").get();
  assert.ok(self);
  for (const [type, id] of [
    ['person', 'patient'],
    ['note', String(self.id)],
  ] satisfies Array<[Parameters<typeof setVisibility>[1], string]>)
    assert.throws(
      () => setVisibility(db, type, id, { archived: true, version: 0 }),
      (e) => hasCode(e, 'SELF_PROFILE'),
    );
  const person = createNote(db, {
    kind: 'person',
    title: 'Example relative',
    content: 'Retained',
    archived: true,
  });
  assert.ok(person.personId);
  setVisibility(db, 'note', person.id, { archived: false, version: 0 });
  assert.equal(linkTarget(db, 'person', person.personId).archived, false);
  setVisibility(db, 'person', person.personId, { archived: true, version: 1 });
  assert.equal(linkTarget(db, 'note', person.id).archived, true);
  assert.equal(listNotes(db, params({ kind: 'person', visibility: 'archived' })).total, 1);
  assert.throws(
    () => saveNote(db, person.id, { ...getNote(db, person.id), archived: false }),
    /current visibility version/,
  );
  assert.equal(visibilityState(db, 'person', person.personId).history.length, 2);
});
test('archive coordinates personal current use and preserves chart history, source evidence and same-spelled source identities', (t) => {
  const { db } = fixture(t);
  const before = db.prepare('SELECT * FROM medications').get();
  setMedicationCurrentStatus(db, 'med', { status: 'current', version: 0, visibilityVersion: 0 });
  setVisibility(db, 'medication', 'med', { archived: true, version: 0, currentStatusVersion: 1 });
  assert.equal(clinicalList(db, 'medications', params()).total, 0);
  assert.equal(clinicalList(db, 'medications', params({ status: 'archived' })).total, 1);
  const medication = clinicalList(db, 'medications', params(), 'med');
  assert.ok(!('reclassifiedTo' in medication));
  assert.equal(medication.currentStatus, 'not_current');
  assert.deepEqual(db.prepare('SELECT * FROM medications').get(), before);
  setMedicationCurrentStatus(db, 'med', {
    status: 'not_current',
    version: 2,
    visibilityVersion: 1,
  });
  assert.equal(visibilityState(db, 'medication', 'med').archived, true);
  setVisibility(db, 'observation', 'result', { archived: true, version: 0 });
  setVisibility(db, 'test_type', 'test', { archived: true, version: 0 });
  assert.equal(observations(db, params()).total, 0);
  assert.equal(trends(db, params({ ids: 'test' }))[0]!.points[0]!.id, 'result');
  setVisibility(db, 'source', 'same', { archived: true, version: 0 });
  assert.equal(sourceRecords(db, params()).total, 0);
  assert.equal(sourceFiles(db, params()).total, 1);
  setVisibility(db, 'source_file', 'same', { archived: true, version: 0 });
  assert.equal(sourceFiles(db, params()).total, 0);
  assert.equal(db.prepare('SELECT raw_json FROM source_records').get()?.raw_json, '{}');
});
test('original source record filter follows only server-attested proposal lineage with stable archive pagination', (t) => {
  const { db } = fixture(t);
  db.exec(
    "INSERT INTO providers VALUES('reviewed-source','Fictional Reviewed Vision'),('file-source','Fictional Acquisition Service')",
  );
  const insertFile = db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  );
  insertFile.run('root-original', 'fictional/root.png', 'root-hash', 10, 'intake_original', '{}');
  db.prepare("UPDATE source_files SET provider_id='file-source' WHERE id='root-original'").run();
  insertFile.run(
    'proposal-current',
    'fictional/current.jsonl',
    'current-hash',
    20,
    'intake_proposal',
    JSON.stringify({ originalSourceFileId: 'root-original' }),
  );
  insertFile.run(
    'proposal-history',
    'fictional/history.jsonl',
    'history-hash',
    20,
    'intake_proposal',
    JSON.stringify({ originalSourceFileId: 'root-original' }),
  );
  insertFile.run(
    'other-original',
    'fictional/other.png',
    'other-hash',
    10,
    'intake_original',
    '{}',
  );
  insertFile.run(
    'proposal-unrelated',
    'fictional/unrelated.jsonl',
    'unrelated-hash',
    20,
    'intake_proposal',
    JSON.stringify({ originalSourceFileId: 'other-original' }),
  );
  const insertRecord = db.prepare(
    'INSERT INTO source_records(id,source_file_id,raw_json,locator_json) VALUES(?,?,?,?)',
  );
  insertRecord.run('direct', 'root-original', '{}', '{}');
  insertRecord.run(
    'current',
    'proposal-current',
    '{}',
    JSON.stringify({ originalSourceFileId: 'root-original' }),
  );
  insertRecord.run(
    'history',
    'proposal-history',
    '{}',
    JSON.stringify({ originalSourceFileId: 'root-original' }),
  );
  insertRecord.run(
    'spoofed-locator',
    'proposal-unrelated',
    '{}',
    JSON.stringify({ originalSourceFileId: 'root-original' }),
  );
  insertRecord.run('unrelated-direct', 'other-original', '{}', '{}');
  db.prepare(
    "UPDATE source_records SET provider_id='reviewed-source' WHERE id IN ('current','history')",
  ).run();
  setVisibility(db, 'source', 'history', { archived: true, version: 0 });

  const visible = sourceRecords(db, params({ originalSourceFileId: 'root-original', limit: '1' }));
  assert.equal(visible.total, 2);
  assert.equal(visible.complete, false);
  assert.deepEqual(
    [0, 1].flatMap((offset) =>
      sourceRecords(
        db,
        params({ originalSourceFileId: 'root-original', limit: '1', offset: String(offset) }),
      ).data.map((record) => record.id),
    ),
    ['current', 'direct'],
  );
  const all = sourceRecords(
    db,
    params({ originalSourceFileId: 'root-original', visibility: 'all' }),
  );
  assert.deepEqual(
    all.data.map((record) => record.id),
    ['current', 'direct', 'history'],
  );
  assert.equal(all.total, 3);
  assert.ok(!all.data.some((record) => record.id === 'spoofed-locator'));
  assert.equal(sourceRecords(db, params({ providerId: 'reviewed-source' })).total, 1);
  assert.deepEqual(
    sourceRecords(db, params({ providerId: 'reviewed-source', visibility: 'all' })).data.map(
      (record) => [record.id, record.provider],
    ),
    [
      ['current', 'Fictional Reviewed Vision'],
      ['history', 'Fictional Reviewed Vision'],
    ],
  );
  assert.equal(getSourceRecord(db, 'direct').provider, null);
  const detail = getSourceRecord(db, 'current');
  assert.equal(detail.provider, 'Fictional Reviewed Vision');
  assert.equal(detail.extractionFile!.id, 'proposal-current');
  assert.equal(detail.file!.id, 'proposal-current');
  assert.equal(detail.originalFile!.id, 'root-original');
  assert.equal(detail.originalFile!.provider, 'Fictional Acquisition Service');
});
test('visibility mutations enforce origin/profile boundaries and stable archived HTTP detail links', async (t) => {
  const { db, root } = fixture(t),
    app = createApp({ root, databases: new Map([['cedar', db]]) });
  await new Promise<void>((resolveListen) => app.server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>((resolveClose) => app.server.close(() => resolveClose())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/cedar`,
    path = base + '/visibility/medication/med';
  const body = JSON.stringify({ archived: true, version: 0, currentStatusVersion: 0 });
  assert.equal((await fetch(path, { method: 'PATCH', body })).status, 403);
  const headers = { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' };
  assert.equal((await fetch(path, { method: 'PATCH', headers, body })).status, 200);
  const detail = (await (await fetch(base + '/medications/med')).json()) as {
    data: { archived: boolean };
  };
  assert.equal(detail.data.archived, true);
  assert.equal((await fetch(path, { method: 'PATCH', headers, body })).status, 409);
  assert.equal((await fetch(path, { method: 'DELETE', headers, body: '{}' })).status, 404);
  assert.equal((await fetch(base + '/visibility/note/missing')).status, 404);
});
test('portable rebuild preserves archive history and immutable links without the working database', (t) => {
  const { db, root, paths } = fixture(t);
  attachPersonalDurability(db, { root, profileId: 'cedar' });
  const draft = createNote(db, { kind: 'historical', title: 'Visit', content: 'Frozen' }),
    note = finishNote(db, draft.id, { ...draft });
  const linked = createNote(db, {
    title: 'Linked context',
    content: 'See visit',
    links: [{ targetType: 'note', targetId: note.id }],
  });
  setVisibility(db, 'note', note.id, { archived: true, version: 0 });
  setVisibility(db, 'note', note.id, { archived: false, version: 1 });
  setVisibility(db, 'note', note.id, { archived: true, version: 2 });
  const expected = visibilityState(db, 'note', note.id);
  exportCuration(db, root, 'cedar');
  for (const kind of ['personal', 'curation'] as const) {
    const pointer = JSON.parse(readFileSync(resolve(paths[kind], 'current.json'), 'utf8'));
    const generation = JSON.parse(readFileSync(resolve(paths[kind], pointer.file), 'utf8'));
    assert.equal(Object.hasOwn(generation.tables, 'visibility_events'), kind === 'personal');
  }
  db.close();
  const rebuilt = rebuildProfile(root, 'cedar', resolve(root, 'rebuilt')),
    restored = openDatabase(rebuilt.database, 'cedar');
  try {
    assert.deepEqual(visibilityState(restored, 'note', note.id), expected);
    assert.equal(getNote(restored, linked.id).links[0]!.archived, true);
    assert.equal(getNote(restored, note.id).version, note.version);
    assert.equal(getNote(restored, note.id).content, 'Frozen');
  } finally {
    restored.close();
  }
});
