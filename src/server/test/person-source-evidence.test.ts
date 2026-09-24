import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, type Database } from '../database.ts';
import { createNote } from '../notes.ts';
import { personSourceEvidence } from '../person-source-evidence.ts';
import { createApp } from '../index.ts';
import type { PersonSourceEvidence } from '../../shared/api.ts';

const noteId = 'note:00000000-0000-4000-8000-000000000101';

function fixture(t: TestContext, profileId = 'cookie-dough') {
  const root = mkdtempSync(resolve(tmpdir(), 'health-person-source-evidence-'));
  const db = openDatabase(resolve(root, `${profileId}.sqlite`), profileId);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, db, profileId };
}

function person(db: Database, id = noteId) {
  return createNote(db, {
    id,
    kind: 'person',
    title: 'Fictional Juniper Vale',
    person: { fullName: 'Fictional Juniper Vale' },
  });
}

function sourceFile(db: Database, id = 'file:fictional-shared') {
  db.prepare('INSERT INTO source_files(id,path,sha256,bytes,mime_type) VALUES(?,?,?,?,?)').run(
    id,
    `originals/${id}.jsonl`,
    id.padEnd(64, '0').slice(0, 64),
    128,
    'application/jsonl',
  );
}

function source(db: Database, id: string, label: string | null = null) {
  db.prepare(
    `INSERT INTO source_records
      (id,source_file_id,source_key,kind,label,raw_json,locator_json,extraction_status)
      VALUES(?, 'file:fictional-shared', ?, 'record', ?, '{}', '{}', 'retained')`,
  ).run(id, id, label);
}

function evidence(
  db: Database,
  id: string,
  type: 'person' | 'observation' | 'medication' | 'procedure' | 'document',
  entityId: string,
  sourceRecordId: string,
  role = 'source',
) {
  db.prepare(
    'INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role) VALUES(?,?,?,?,?)',
  ).run(id, type, entityId, sourceRecordId, role);
}

function document(
  db: Database,
  id: string,
  sourceRecordId: string,
  title: string,
  optical = false,
) {
  const extra = optical
    ? { import: { acceptedMapping: { opticalPrescription: { type: 'spectacle', eyes: [] } } } }
    : {};
  db.prepare(
    'INSERT INTO documents(id,source_record_id,title,effective_at,text_content,extra_json) VALUES(?,?,?,?,?,?)',
  ).run(id, sourceRecordId, title, '2031-01-08', 'Fictional retained text', JSON.stringify(extra));
}

test('groups all exact Person sources while preserving current, missing, inactive and optical entry state', (t) => {
  const { db } = fixture(t);
  const saved = person(db);
  sourceFile(db);
  for (const [id, label] of [
    ['source:primary', 'Fictional follow-up summary'],
    ['source:later', 'fictional-people-only'],
    ['source:only', 'Fictional source-only statement'],
    ['source:missing', 'd65e2670-3509-4cb1-bbd3-0ab4224b29ea'],
    ['source:unrelated', 'Fictional same-file unrelated record'],
  ] as const)
    source(db, id, label);

  // Simulate the primary add plus later updates: all exact Person evidence must appear.
  for (const [index, sourceId] of [
    'source:primary',
    'source:later',
    'source:only',
    'source:missing',
  ].entries())
    evidence(db, `evidence:person:${index}`, 'person', saved.personId!, sourceId);

  document(db, 'document:reused', 'source:primary', 'Fictional reused summary');
  evidence(db, 'evidence:doc:primary', 'document', 'document:reused', 'source:primary');
  // A reused entity can truthfully cite a later exact source without being duplicated.
  evidence(db, 'evidence:doc:later', 'document', 'document:reused', 'source:later');
  evidence(
    db,
    'evidence:doc:later:excerpt',
    'document',
    'document:reused',
    'source:later',
    'excerpt',
  );

  document(db, 'document:optical', 'source:later', 'Fictional spectacle prescription', true);
  evidence(db, 'evidence:optical', 'document', 'document:optical', 'source:later');
  db.prepare('INSERT INTO visibility_events VALUES(?,?,?,?,?,?,?)').run(
    'visibility:optical',
    'document',
    'document:optical',
    1,
    1,
    '2031-01-09',
    'Profile owner',
  );

  // A journaled old classification navigates to the current stable-ID classification.
  db.prepare("INSERT INTO test_types(id,label) VALUES('type:fictional','Fictional panel')").run();
  db.prepare(
    `INSERT INTO observations
      (id,test_type_id,source_record_id,label,value_text,effective_at)
      VALUES('entry:reclassified','type:fictional','source:primary','Fictional level','within range','2031-01-08')`,
  ).run();
  db.prepare(
    `INSERT INTO manual_batches(id,title,status,created_at,coverage_json)
      VALUES('batch:reclassification','Import record exception','verified','2031-01-09',?)`,
  ).run(
    JSON.stringify({
      recordException: {
        reclassification: {
          recordId: 'entry:reclassified',
          fromKind: 'procedure',
          toKind: 'observation',
        },
        sequence: 1,
      },
    }),
  );
  evidence(db, 'evidence:reclassified', 'procedure', 'entry:reclassified', 'source:primary');
  evidence(
    db,
    'evidence:reclassified:current',
    'observation',
    'entry:reclassified',
    'source:primary',
  );
  evidence(db, 'evidence:missing', 'medication', 'entry:missing', 'source:missing');

  // Same file, report-like labels, and date proximity never associate another source.
  document(db, 'document:unrelated', 'source:unrelated', 'Fictional unrelated summary');
  evidence(db, 'evidence:unrelated', 'document', 'document:unrelated', 'source:unrelated');
  db.prepare('INSERT INTO visibility_events VALUES(?,?,?,?,?,?,?)').run(
    'visibility:source-only',
    'source',
    'source:only',
    1,
    1,
    '2031-01-09',
    'Profile owner',
  );

  const result = personSourceEvidence(db, saved.id, new URLSearchParams({ limit: '20' }));
  assert.equal(result.total, 4);
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.data.map((item) => item.sourceRecordId),
    ['source:later', 'source:missing', 'source:only', 'source:primary'],
  );
  assert.equal(
    result.data.some((item) => item.sourceRecordId === 'source:unrelated'),
    false,
  );
  const later = result.data.find((item) => item.sourceRecordId === 'source:later')!;
  assert.match(later.sourceTitle, /file:fictional-shared\.jsonl/);
  assert.match(
    result.data.find((item) => item.sourceRecordId === 'source:missing')!.sourceTitle,
    /file:fictional-shared\.jsonl/,
  );
  assert.equal(
    result.data.find((item) => item.sourceRecordId === 'source:primary')!.sourceTitle,
    'Fictional follow-up summary',
  );
  assert.equal(later.entries.filter((entry) => entry.entityId === 'document:reused').length, 1);
  assert.deepEqual(
    later.entries.find((entry) => entry.entityId === 'document:optical'),
    {
      entityId: 'document:optical',
      kind: 'document',
      title: 'Fictional spectacle prescription',
      archived: true,
      missing: false,
      appUrl: '/tests?view=vision&document=document%3Aoptical&visibility=all',
    },
  );
  assert.equal(
    result.data.find((item) => item.sourceRecordId === 'source:only')!.sourceArchived,
    true,
  );
  assert.deepEqual(result.data.find((item) => item.sourceRecordId === 'source:only')!.entries, []);
  assert.deepEqual(
    result.data.find((item) => item.sourceRecordId === 'source:missing')!.entries[0],
    {
      entityId: 'entry:missing',
      kind: 'medication',
      title: 'Unavailable linked record',
      archived: false,
      missing: true,
    },
  );
  assert.equal(
    result.data
      .find((item) => item.sourceRecordId === 'source:primary')!
      .entries.filter((entry) => entry.entityId === 'entry:reclassified').length,
    1,
  );
  assert.equal(
    result.data
      .find((item) => item.sourceRecordId === 'source:primary')!
      .entries.find((entry) => entry.entityId === 'entry:reclassified')!.kind,
    'observation',
  );
  assert.throws(
    () => personSourceEvidence(db, saved.id, new URLSearchParams({ limit: '2.5' })),
    /whole-number evidence page limits/,
  );
  assert.throws(() => {
    const ordinary = createNote(db, { title: 'Fictional ordinary note' });
    personSourceEvidence(db, ordinary.id, new URLSearchParams());
  }, /saved Person/);
});

test('pages distinct sources without missing or duplicating their exact entry groups', (t) => {
  const { db } = fixture(t);
  const saved = person(db);
  sourceFile(db);
  for (let index = 0; index < 21; index += 1) {
    const suffix = String(index).padStart(2, '0');
    const sourceId = `source:page:${suffix}`;
    source(db, sourceId, `Fictional source ${suffix}`);
    evidence(db, `evidence:person:${suffix}`, 'person', saved.personId!, sourceId);
    for (const entry of ['a', 'b']) {
      const documentId = `document:${suffix}:${entry}`;
      document(db, documentId, sourceId, `Fictional entry ${suffix} ${entry}`);
      evidence(db, `evidence:${suffix}:${entry}`, 'document', documentId, sourceId);
    }
  }
  const first = personSourceEvidence(
    db,
    saved.id,
    new URLSearchParams({ limit: '20', offset: '0' }),
  );
  const second = personSourceEvidence(
    db,
    saved.id,
    new URLSearchParams({ limit: '20', offset: '20' }),
  );
  assert.equal(first.total, 21);
  assert.equal(first.data.length, 20);
  assert.equal(first.complete, false);
  assert.equal(second.data.length, 1);
  assert.equal(second.complete, false);
  assert.equal(
    new Set([...first.data, ...second.data].map((item) => item.sourceRecordId)).size,
    21,
  );
  assert.equal(
    [...first.data, ...second.data].every((item) => item.entries.length === 2),
    true,
  );
});

test('read-only API keeps source evidence inside the selected profile', async (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'health-person-source-api-'));
  const first = openDatabase(resolve(root, 'first.sqlite'), 'cookie-dough');
  const second = openDatabase(resolve(root, 'second.sqlite'), 'cedar');
  t.after(() => {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  });
  const sameId = noteId;
  const firstPerson = person(first, sameId);
  const secondPerson = person(second, sameId);
  for (const [db, personId, marker] of [
    [first, firstPerson.personId!, 'first'],
    [second, secondPerson.personId!, 'second'],
  ] as const) {
    sourceFile(db);
    source(db, `source:${marker}`, `Fictional ${marker} profile evidence`);
    evidence(db, `evidence:${marker}`, 'person', personId, `source:${marker}`);
  }
  const app = createApp({
    root,
    databases: new Map([
      ['cookie-dough', first],
      ['cedar', second],
    ]),
  });
  await new Promise<void>((ready) => app.server.listen(0, '127.0.0.1', ready));
  t.after(() => new Promise<void>((done) => app.server.close(() => done())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles`;
  const get = async (profileId: string) => {
    const response = await fetch(
      `${base}/${profileId}/notes/${encodeURIComponent(sameId)}/source-evidence`,
    );
    assert.equal(response.status, 200);
    return (await response.json()) as { data: PersonSourceEvidence[]; meta: { total: number } };
  };
  const firstResult = await get('cookie-dough');
  const secondResult = await get('cedar');
  assert.deepEqual(
    firstResult.data.map((item) => item.sourceRecordId),
    ['source:first'],
  );
  assert.deepEqual(
    secondResult.data.map((item) => item.sourceRecordId),
    ['source:second'],
  );
  assert.equal(firstResult.meta.total, 1);
  const rejected = await fetch(
    `${base}/cookie-dough/notes/${encodeURIComponent(sameId)}/source-evidence`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
      body: '{}',
    },
  );
  assert.equal(rejected.status, 405);
  assert.equal(
    ((await rejected.json()) as { error: { code: string } }).error.code,
    'READ_ONLY_RESOURCE',
  );
});
