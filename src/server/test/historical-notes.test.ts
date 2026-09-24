import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, revision } from '../database.ts';
import type { Database } from '../database.ts';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createNote, finishNote, getNote } from '../notes.ts';
import { createApp } from '../index.ts';
import {
  CLINICIAN_NOTE_TYPES,
  historicalNotes,
  getHistoricalNote,
  historicalNoteOptions,
} from '../historical-notes.ts';

interface DocumentOptions {
  sourceFields?: Record<string, unknown>;
  reviewed?: unknown;
  issuer?: string;
  date?: string | null;
  content?: string;
}
interface ProviderExtra {
  unmodeled: { kept: boolean };
}
const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code;
const responseJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

function fixture(t: TestContext, owner = 'cedar') {
  const root = mkdtempSync(resolve(tmpdir(), 'health-history-test-'));
  const db = openDatabase(resolve(root, 'data/database.sqlite'), owner);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  db.exec(
    "INSERT INTO providers VALUES('issuer','Source issuing provider'),('other','Other issuer'),('capture','Acquiring provider'); INSERT INTO source_files(id,provider_id,path,sha256,bytes) VALUES('file','capture','providers/fixture.json','x',1)",
  );
  return { db, root };
}
function document(
  db: Database,
  id: string,
  type: string | null = 'Progress Notes',
  options: DocumentOptions = {},
) {
  const sourceFields = {
    type,
    source: 'Source-stated issuer',
    status: 'current',
    author: ['Original author'],
    ...options.sourceFields,
  };
  const extra = {
    sourceFields,
    historicalNote: options.reviewed ?? null,
    unmodeled: { kept: true },
  };
  db.prepare(
    "INSERT INTO source_records(id,source_file_id,provider_id,raw_json) VALUES(?,'file','capture',?)",
  ).run('raw:' + id, JSON.stringify({ original: extra }));
  db.prepare(
    'INSERT INTO documents(id,source_record_id,provider_id,title,effective_at,text_content,extra_json) VALUES(?,?,?,?,?,?,?)',
  ).run(
    id,
    'raw:' + id,
    options.issuer || 'issuer',
    type || 'Native document',
    options.date ?? '2026-08-17T20:22:53Z',
    options.content ?? 'Original narrative with a mole check.',
    JSON.stringify(extra),
  );
  db.prepare(
    "INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role,locator_json) VALUES(?,'document',?,?,'capture',?)",
  ).run(
    'evidence:' + id,
    id,
    'raw:' + id,
    JSON.stringify({ path: 'source-original', suppliedBy: 'capture' }),
  );
  return id;
}
const list = (db: Database, params: Record<string, string> = {}) =>
  historicalNotes(db, new URLSearchParams(params));

test('historical union uses explicit source types, keeps issuing/capture attribution and reviewed dates separate', (t) => {
  const { db } = fixture(t);
  for (const type of CLINICIAN_NOTE_TYPES) document(db, type, type);
  for (const type of [
    'Laboratory report',
    'Pathology study',
    'Diagnostic imaging study',
    'Novel note',
    null,
  ]) {
    document(db, 'excluded:' + type, type);
    assert.throws(
      () => getHistoricalNote(db, 'excluded:' + type),
      (e: unknown) => hasCode(e, 'NOT_FOUND'),
    );
  }
  assert.equal(list(db).total, CLINICIAN_NOTE_TYPES.length);
  const plain = getHistoricalNote(db, 'Progress Notes');
  assert.equal(plain.origin, 'provider');
  assert.equal(plain.status, 'provider');
  assert.equal(plain.sourceStatus, 'current');
  assert.equal(plain.readOnly, true);
  assert.equal(plain.sourceLabel, 'Source-stated issuer');
  assert.equal(plain.sourceId, 'issuer');
  assert.equal((plain.evidence[0]?.locator as { suppliedBy: string }).suppliedBy, 'capture');
  assert.equal(plain.date, '2026-08-17T20:22:53Z');
  assert.equal(plain.recordDate, plain.date);
  assert.equal(plain.eventDate, null);
  assert.equal(plain.dateBasis, 'Source record date');
  assert.equal(plain.typeLabel, 'Progress Notes');
  assert.deepEqual(plain.authors, ['Original author']);
  assert.equal(plain.content, 'Original narrative with a mole check.');
  assert.equal((plain.extra as ProviderExtra).unmodeled.kept, true);
  document(db, 'reviewed', 'Progress Notes', {
    reviewed: {
      title: 'Mole follow-up',
      typeLabel: 'Primary care',
      eventDate: '2026-08-17',
      dateBasis: 'Visit date explicitly stated in source',
      classificationBasis: 'Reviewed encounter context',
      presentationNote: 'Original source retained',
    },
  });
  const reviewed = getHistoricalNote(db, 'reviewed');
  assert.equal(reviewed.title, 'Mole follow-up');
  assert.equal(reviewed.typeLabel, 'Primary care');
  assert.equal(reviewed.sourceType, 'Progress Notes');
  assert.equal(reviewed.eventDate, '2026-08-17');
  assert.equal(reviewed.date, '2026-08-17');
  assert.equal(reviewed.recordDate, '2026-08-17T20:22:53Z');
  assert.equal(reviewed.dateBasis, 'Visit date explicitly stated in source');
  assert.equal(reviewed.classificationBasis, 'Reviewed encounter context');
  assert.equal(reviewed.presentationNote, 'Original source retained');
  document(db, 'malformed-review', 'Progress Notes', {
    reviewed: {
      title: {},
      typeLabel: '',
      eventDate: 37,
      dateBasis: ['not text'],
    },
  });
  const invalid = getHistoricalNote(db, 'malformed-review');
  assert.equal(invalid.title, 'Progress Notes');
  assert.equal(invalid.eventDate, null);
  assert.equal(invalid.dateBasis, 'Source record date');
});

test('union pagination, search, type/source/status filters and global options agree without reclassifying personal notes', (t) => {
  const { db } = fixture(t);
  document(db, 'older', 'Telephone Encounter', { date: '2026-08-12' });
  document(db, 'newer', 'Progress Notes', {
    issuer: 'other',
    date: '2026-08-18',
    sourceFields: { source: 'Other stated issuer' },
    reviewed: { typeLabel: 'Primary care' },
  });
  let finished = createNote(db, {
    kind: 'historical',
    title: 'Personal finished',
    content: 'Personal mole note',
    typeLabel: 'Primary care',
    eventDate: '2026-08-17',
  });
  finished = finishNote(db, finished.id, {
    version: finished.version,
    title: finished.title,
    content: finished.content,
    links: [],
  });
  const draft = createNote(db, {
    kind: 'historical',
    title: 'Personal draft',
    content: 'Preparation',
    typeLabel: 'Therapy',
    eventDate: '2026-08-17',
    topics: 'Topic needle',
    rawThoughts: 'Thought needle',
  });
  createNote(db, {
    kind: 'note',
    title: 'Editable singleton',
    content: 'not historical',
  });
  createNote(db, {
    kind: 'person',
    title: 'Person',
    content: 'not historical',
  });
  const archived = createNote(db, {
    kind: 'historical',
    title: 'Archived draft',
    archived: true,
    typeLabel: 'Hidden category',
  });
  assert.equal(list(db).total, 4);
  assert.equal(list(db).complete, true);
  assert.equal(list(db, { source: 'personal' }).total, 2);
  assert.equal(list(db, { source: 'provider' }).total, 2);
  assert.equal(list(db, { source: 'other' }).data[0].id, 'newer');
  assert.equal(list(db, { source: 'not-a-provider' }).total, 0);
  assert.equal(list(db, { status: 'draft' }).data[0].id, draft.id);
  assert.equal(list(db, { status: 'finished' }).data[0].id, finished.id);
  assert.equal(list(db, { status: 'provider' }).total, 2);
  assert.equal(list(db, { source: 'provider', status: 'finished' }).total, 0);
  assert.equal(list(db, { typeLabel: 'primary CARE' }).total, 2);
  assert.equal(list(db, { typeLabel: 'Primary care', source: 'other' }).total, 1);
  assert.equal(list(db, { q: 'Original author' }).total, 2);
  assert.equal(list(db, { q: 'Other stated' }).total, 1);
  assert.equal(list(db, { q: 'Thought needle' }).total, 1);
  assert.throws(
    () => list(db, { status: 'current' }),
    (e: unknown) => hasCode(e, 'INVALID_INPUT'),
  );
  const allIds = list(db).data.map((row) => row.id);
  assert.equal(allIds[0], 'newer');
  assert.equal(allIds.at(-1), 'older');
  const paged = [0, 1, 2, 3].map((offset) => {
    const page = list(db, { limit: '1', offset: String(offset) });
    assert.equal(page.total, 4);
    assert.equal(page.complete, false);
    return page.data[0].id;
  });
  assert.deepEqual(paged, allIds);
  assert.equal(list(db, { sort: 'oldest' }).data[0].id, 'older');
  const archivedDetail = getHistoricalNote(db, archived.id);
  assert.equal(archivedDetail.origin, 'personal');
  assert.equal(archivedDetail.note.archived, true);
  const personal = getHistoricalNote(db, finished.id);
  assert.equal(personal.origin, 'personal');
  assert.deepEqual(personal.note, getNote(db, finished.id));
  assert.equal(personal.readOnly, true);
  assert.equal(personal.sourceId, 'personal');
  assert.equal(personal.sourceStatus, null);
  const options = historicalNoteOptions(db);
  assert.deepEqual(
    options.sources.map((s) => [s.id, s.count]),
    [
      ['all', 4],
      ['personal', 2],
      ['provider', 2],
      ['other', 1],
      ['issuer', 1],
    ],
  );
  assert.deepEqual(options.types, ['Primary care', 'Telephone Encounter', 'Therapy']);
});

test('personal creation fallback is UTC while provider record dates and date-only event dates stay source-exact', (t) => {
  const { db } = fixture(t);
  const note = createNote(db, {
    kind: 'historical',
    title: 'Undated personal draft',
  });
  db.prepare("UPDATE notes SET created_at='2026-08-17 20:22:53' WHERE id=?").run(note.id);
  const personal = getHistoricalNote(db, note.id);
  assert.equal(personal.date, '2026-08-17T20:22:53Z');
  assert.equal(personal.dateBasis, 'Note creation date');
  document(db, 'source-date', 'Progress Notes', {
    date: '2026-08-17 20:22:53',
  });
  assert.equal(getHistoricalNote(db, 'source-date').date, '2026-08-17 20:22:53');
});

test('HTTP historical reads are profile-scoped and provider mutation attempts cannot change documents, raw records or personal history', async (t) => {
  const { db, root } = fixture(t);
  const { db: placebo } = fixture(t, 'cookie-dough');
  document(db, 'real-only');
  document(placebo, 'placebo-only', 'Patient Instructions', {
    content: 'Fictional instruction',
  });
  const personal = createNote(db, {
    kind: 'historical',
    title: 'Draft remains editable',
  });
  db.exec(
    "INSERT INTO assets(id,original_name,stored_path,mime_type,bytes,sha256,created_at) VALUES('asset','scan.pdf','data/attachments/cedar/scan.pdf','application/pdf',1,'hash','2026-08-17 20:22:53'); INSERT INTO attachments(id,asset_id,owner_type,owner_id,caption,created_at) VALUES('attachment','asset','document','real-only','Original attachment','2026-08-17 20:22:53')",
  );
  const snapshot = () =>
    JSON.stringify({
      docs: db.prepare('SELECT * FROM documents ORDER BY id').all(),
      raw: db.prepare('SELECT * FROM source_records ORDER BY id').all(),
      notes: db.prepare('SELECT * FROM notes ORDER BY id').all(),
      attachments: db.prepare('SELECT * FROM attachments ORDER BY id').all(),
      revision: revision(db),
    });
  const before = snapshot();
  const app = createApp({
    root,
    databases: new Map([
      ['cedar', db],
      ['cookie-dough', placebo],
    ]),
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()));
  t.after(() => new Promise<void>((resolve) => app.server.close(() => resolve())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api`;
  let response = await fetch(
    base + '/profiles/cedar/historical-notes/real-only?source=personal&status=draft&q=missing',
  );
  assert.equal(response.status, 200);
  const detail = (
    await responseJson<{
      data: {
        status: string;
        attachments: Array<{ asset: { contentUrl: string } }>;
        evidence: Array<{ sourceRecordId: string }>;
      };
    }>(response)
  ).data;
  assert.equal(detail.status, 'provider');
  assert.equal(detail.attachments[0].asset.contentUrl, '/api/profiles/cedar/assets/asset/content');
  assert.equal(detail.evidence[0].sourceRecordId, 'raw:real-only');
  response = await fetch(base + '/profiles/cookie-dough/historical-notes');
  const placeboList = await responseJson<{
    data: Array<{ id: string }>;
    meta: { total: number };
  }>(response);
  assert.deepEqual(
    placeboList.data.map((d) => d.id),
    ['placebo-only'],
  );
  assert.equal(placeboList.meta.total, 1);
  assert.equal(
    (await fetch(base + '/profiles/cookie-dough/historical-notes/real-only')).status,
    404,
  );
  assert.equal((await fetch(base + '/historical-notes')).status, 404);
  response = await fetch(base + '/profiles/cedar/historical-note-options');
  assert.equal(response.status, 200);
  assert.equal(
    (await responseJson<{ data: { sources: Array<{ count: number }> } }>(response)).data.sources[0]
      ?.count,
    2,
  );
  for (const [method, path, expected] of [
    ['POST', '/historical-notes', 405],
    ['PUT', '/historical-notes/real-only', 405],
    ['PATCH', '/historical-notes/real-only', 405],
    ['DELETE', '/historical-notes/real-only', 405],
    ['POST', '/historical-notes/real-only/finish', 405],
    ['PUT', '/notes/real-only', 404],
    ['POST', '/notes/real-only/finish', 404],
    ['PUT', '/documents/real-only', 404],
  ] as const) {
    response = await fetch(base + '/profiles/cedar' + path, {
      method,
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Overwrite attempt', version: 1 }),
    });
    assert.equal(response.status, expected, method + ' ' + path);
  }
  assert.equal(snapshot(), before);
  response = await fetch(base + '/profiles/cedar/notes/' + personal.id, {
    method: 'PUT',
    headers: {
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: 'Existing personal editor works',
      version: personal.version,
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(
    (await responseJson<{ data: { title: string } }>(response)).data.title,
    'Existing personal editor works',
  );
});
