import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, revision } from '../database.ts';
import {
  createNote,
  getNote,
  saveNote,
  convertNote,
  finishNote,
  correctionNote,
} from '../notes.ts';
import {
  uploadAsset,
  createAttachment,
  editAttachment,
  hash,
  profileFile,
  verifyNoteAssets,
} from '../assets.ts';
import { readQuery } from '../query.ts';
import { createBackup, restoreBackup } from '../recovery.ts';
import { createApp } from '../index.ts';
import type { AttachmentInput } from '../../shared/api.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-api-test-'));
  const db = openDatabase(resolve(root, 'data/database.sqlite'), 'cedar');
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { db, root };
}
function requiredRow<T extends object>(value: unknown): T {
  assert.ok(value && typeof value === 'object');
  return value as T;
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
const input = {
  kind: 'historical',
  title: 'Visit preparation',
  content: 'Questions',
  links: [],
  typeLabel: 'Therapy',
};
const png = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082',
  'hex',
);
test('draft lifecycle, same-id conversion, current linked targets and immutable finished record', (t) => {
  const { db } = fixture(t);
  let mom = createNote(db, {
    kind: 'person',
    title: 'Mom',
    content: 'Original',
    person: { relationship: 'mother' },
  });
  let note = createNote(db, {
    title: 'Annual Things',
    content: 'Check list',
    pinned: true,
    links: [{ targetType: 'person', targetId: mom.personId }],
  });
  const originalId = note.id;
  note = convertNote(db, note.id, {
    version: note.version,
    typeLabel: '  therapy  ',
  });
  assert.equal(note.id, originalId);
  assert.equal(note.status, 'draft');
  assert.equal(note.pinned, true);
  assert.equal(note.typeLabel, 'Therapy');
  const stale = note.version;
  note = saveNote(db, note.id, {
    version: note.version,
    title: 'Visit',
    content: 'During appointment',
  });
  assert.throws(
    () =>
      finishNote(db, note.id, {
        version: stale,
        title: 'stale',
        content: 'stale',
        links: [],
      }),
    /changed/,
  );
  assert.equal(getNote(db, note.id).status, 'draft');
  note = finishNote(db, note.id, {
    version: note.version,
    title: 'Visit complete',
    content: 'Final words',
    links: note.links,
  });
  assert.throws(
    () =>
      saveNote(db, note.id, {
        version: note.version,
        title: 'Overwrite',
        content: 'no',
      }),
    /finished/,
  );
  assert.throws(
    () => db.prepare('UPDATE notes SET content=? WHERE id=?').run('bad', note.id),
    /cannot be changed/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM note_links WHERE note_id=?').run(note.id),
    /cannot be changed/,
  );
  mom = saveNote(db, mom.id, {
    version: mom.version,
    title: 'Mom current name',
    content: 'Changed today',
  });
  assert.equal(getNote(db, note.id).links[0].title, 'Mom current name');
  assert.equal(getNote(db, note.id).content, 'Final words');
  const correction = correctionNote(db, note.id, {});
  assert.notEqual(correction.id, note.id);
  assert.equal(correction.status, 'draft');
  assert.equal(correction.links[0].relation, 'corrects');
  assert.equal(getNote(db, note.id).backlinks.length, 1);
});
test('atomic finish rolls back body and links on missing or changed original', (t) => {
  const { db, root } = fixture(t);
  let note = createNote(db, input);
  const asset = uploadAsset(db, root, 'cedar', png, 'mole.png', 'image/png');
  const attachment = createAttachment(db, root, 'cedar', {
    assetId: asset.id,
    ownerType: 'note',
    ownerId: note.id,
    version: note.version,
    eventDate: '2024-02-10',
    bodyLocation: 'left arm',
  });
  note = getNote(db, note.id);
  const rev = revision(db),
    path = requiredRow<{ stored_path: string }>(
      db.prepare('SELECT stored_path FROM assets WHERE id=?').get(asset.id),
    ).stored_path;
  writeFileSync(resolve(root, path), 'changed');
  assert.throws(
    () =>
      finishNote(db, note.id, { ...note, content: 'After', links: [] }, (id) =>
        verifyNoteAssets(db, root, 'cedar', id),
      ),
    /missing or changed/,
  );
  assert.equal(getNote(db, note.id).content, 'Questions');
  assert.equal(revision(db), rev);
  writeFileSync(resolve(root, path), png);
  note = finishNote(db, note.id, { ...note, links: [] }, (id) =>
    verifyNoteAssets(db, root, 'cedar', id),
  );
  assert.throws(
    () =>
      editAttachment(db, attachment.id, {
        version: note.version,
        caption: 'changed',
      }),
    /finished/,
  );
  assert.throws(
    () =>
      createAttachment(db, root, 'cedar', {
        assetId: asset.id,
        ownerType: 'note',
        ownerId: note.id,
        version: note.version,
      }),
    /finished/,
  );
});
test('original file validation, containment and independent duplicate filename attribution', (t) => {
  const { db, root } = fixture(t);
  assert.throws(
    () => uploadAsset(db, root, 'cedar', Buffer.from('<svg/>'), 'bad.svg', 'image/svg+xml'),
    /Choose a PDF/,
  );
  assert.throws(
    () => uploadAsset(db, root, 'cedar', png, 'bad.pdf', 'application/pdf'),
    /do not match/,
  );
  const a = uploadAsset(db, root, 'cedar', png, 'photo.png', 'image/png'),
    b = uploadAsset(db, root, 'cedar', png, 'other.png', 'image/png');
  assert.notEqual(a.id, b.id);
  assert.equal(a.sha256, b.sha256);
  assert.equal(b.originalName, 'other.png');
  assert.throws(() => profileFile(root, '../escape', 'cedar'), /Invalid stored/);
  assert.throws(
    () => profileFile(root, 'providers/kaiser-northwest/record.pdf', 'cookie-dough'),
    /selected profile/,
  );
});
test('read-only SQL supports parameters/joins and rejects writes, pragmas, attach and extensions', async (t) => {
  const { db } = fixture(t);
  createNote(db, input);
  const result = await readQuery(db.location()!, {
    sql: 'SELECT title, count(*) AS n FROM notes WHERE kind=? GROUP BY title',
    params: ['historical'],
  });
  assert.deepEqual(result.rows, [['Visit preparation', 1]]);
  for (const sql of [
    'DELETE FROM notes RETURNING id',
    'PRAGMA table_info(notes)',
    "ATTACH DATABASE '/tmp/leak' AS other",
    'SELECT 1; DELETE FROM notes',
    'SELECT * FROM pragma_database_list',
    "SELECT load_extension('/tmp/x')",
    'WITH x AS (SELECT 1) DELETE FROM notes RETURNING id',
  ])
    await assert.rejects(readQuery(db.location()!, { sql }), (error) =>
      hasCode(error, 'QUERY_REJECTED'),
    );
  assert.equal(requiredRow<{ n: number }>(db.prepare('SELECT COUNT(*) n FROM notes').get()).n, 2);
  const limited = await readQuery(db.location()!, {
    sql: 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100) SELECT x FROM n',
    limit: 3,
  });
  assert.equal(limited.rows.length, 3);
  assert.equal(limited.truncated, true);
  await assert.rejects(
    readQuery(
      db.location()!,
      {
        sql: 'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n',
      },
      { timeoutMs: 200 },
    ),
    (error) => hasCode(error, 'QUERY_TIMEOUT'),
  );
});
test('consistent backup restores drafts, finished links, person identity and all original bytes', async (t) => {
  const { db, root } = fixture(t);
  const person = createNote(db, {
    kind: 'person',
    title: 'Friend',
    content: 'Notes',
    person: { bloodType: 'unknown' },
  });
  let draft = createNote(db, {
    ...input,
    links: [{ targetType: 'person', targetId: person.personId }],
  });
  const asset = uploadAsset(db, root, 'cedar', png, 'photo.png', 'image/png');
  createAttachment(db, root, 'cedar', {
    assetId: asset.id,
    ownerType: 'note',
    ownerId: draft.id,
    version: draft.version,
    eventDate: '2020-02',
  });
  draft = getNote(db, draft.id);
  const finished = finishNote(db, draft.id, { ...draft, links: draft.links });
  createNote(db, { ...input, title: 'Unfinished' });
  const receipt = await createBackup(db, root, 'cedar');
  assert.equal(receipt.files, 1);
  const target = resolve(root, 'restored');
  restoreBackup(receipt.path, target);
  const restored = openDatabase(resolve(target, 'data/database.sqlite'), 'cedar');
  t.after(() => restored.close());
  assert.equal(getNote(restored, finished.id).status, 'finished');
  assert.equal(getNote(restored, finished.id).links[0]!.targetId, person.personId);
  assert.equal(
    requiredRow<{ n: number }>(
      restored.prepare("SELECT count(*) n FROM notes WHERE status='draft'").get(),
    ).n,
    1,
  );
  const stored = requiredRow<{ stored_path: string; sha256: string }>(
    restored.prepare('SELECT stored_path,sha256 FROM assets').get(),
  );
  assert.equal(hash(readFileSync(resolve(target, stored.stored_path))), stored.sha256);
  assert.throws(() => restoreBackup(receipt.path, target), /new or empty/);
});
test('HTTP profile isolation, content URL scope and origin protection', async (t) => {
  const { db, root } = fixture(t);
  const placebo = openDatabase(resolve(root, 'data/profiles/cookie-dough.sqlite'), 'cookie-dough');
  const real = createNote(db, { title: 'Real private note', content: 'secret' });
  const fake = createNote(placebo, {
    title: 'Cookie recipe',
    content: 'fictional',
  });
  const app = createApp({
    root,
    databases: new Map([
      ['cedar', db],
      ['cookie-dough', placebo],
    ]),
  });
  await new Promise<void>((resolveListen) => app.server.listen(0, '127.0.0.1', resolveListen));
  t.after(async () => {
    await new Promise<void>((resolveClose) => app.server.close(() => resolveClose()));
    placebo.close();
  });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  let response = await fetch(base + '/api/profiles/cookie-dough/notes');
  let payload = (await response.json()) as { data: Array<{ id: string }> };
  assert.equal(payload.data.length, 2);
  assert.equal(payload.data[0].id, fake.id);
  response = await fetch(base + '/api/profiles/cookie-dough/notes/' + encodeURIComponent(real.id));
  assert.equal(response.status, 404);
  response = await fetch(base + '/api/notes');
  assert.equal(response.status, 404);
  response = await fetch(base + '/api/profiles/cedar/notes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'attack', content: 'x' }),
  });
  assert.equal(response.status, 403);
  response = await fetch(base + '/api/profiles/cedar/notes', {
    method: 'POST',
    headers: {
      Origin: 'https://evil.example',
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(response.status, 403);
  response = await fetch(base + '/api/profiles/cookie-dough/query', {
    method: 'POST',
    headers: {
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql: 'SELECT title FROM notes' }),
  });
  payload = (await response.json()) as { data: Array<{ id: string }> };
  assert.equal(response.status, 404); // SQL Explorer was retired.
  const uploaded = uploadAsset(db, root, 'cedar', png, 'mine.png', 'image/png');
  response = await fetch(base + '/api/profiles/cedar/assets/' + encodeURIComponent(uploaded.id));
  const assetPayload = (await response.json()) as { data: { contentUrl: string } };
  assert.match(assetPayload.data.contentUrl, /^\/api\/profiles\/cedar\/assets\//);
  response = await fetch(
    base + '/api/profiles/cookie-dough/assets/' + encodeURIComponent(uploaded.id),
  );
  assert.equal(response.status, 404);
});
test('complete trends differ from paginated history and preserve comparator/text results', async (t) => {
  const { db } = fixture(t);
  db.exec(
    "INSERT INTO providers VALUES ('test','Test provider'); INSERT INTO source_files(id,provider_id,path,sha256,bytes) VALUES('f','test','providers/test.json','x',1); INSERT INTO source_records(id,source_file_id,provider_id,raw_json) VALUES('s','f','test','{\"exact\":1.00}'); INSERT INTO test_types(id,label,unit) VALUES('ldl','LDL','mg/dL');",
  );
  const insert = db.prepare(
    "INSERT INTO observations(id,test_type_id,source_record_id,label,effective_at,date_precision,value_text,value_numeric,comparator,unit) VALUES (?,'ldl','s','LDL',?,'day',?,?,?,'mg/dL')",
  );
  for (let i = 0; i < 65; i++)
    insert.run(
      'result-' + i,
      '2026-01-' + String((i % 28) + 1).padStart(2, '0'),
      String(i),
      i,
      null,
    );
  insert.run('text', '2026-01-29', 'Not detected', null, null);
  insert.run('less', '2026-01-30T19:00:00Z', '<5', 5, '<');
  const { observations, trends, testTypes, sourceRecords } = await import('../queries.ts');
  const page = observations(db, new URLSearchParams());
  assert.equal(page.data.length, 50);
  assert.equal(page.total, 67);
  assert.equal(page.complete, false);
  const series = trends(db, new URLSearchParams({ ids: 'ldl', to: '2026-01-30' }))[0];
  assert.ok(series);
  assert.equal(series.points.length, 67);
  assert.equal(series.complete, true);
  assert.equal(series.unplottableCount, 2);
  assert.equal(testTypes(db, new URLSearchParams({ to: '2026-01-30' }))[0]!.count, 67);
  assert.equal(sourceRecords(db, new URLSearchParams()).data[0]!.rawText, '{"exact":1.00}');
});
test('placebo backup contains only selected-profile originals and rejects mislabeled private paths', async (t) => {
  const { root } = fixture(t);
  const db = openDatabase(resolve(root, 'data/profiles/cookie-dough.sqlite'), 'cookie-dough');
  t.after(() => db.close());
  uploadAsset(db, root, 'cookie-dough', png, 'fictional.png', 'image/png');
  const receipt = await createBackup(db, root, 'cookie-dough');
  const manifest = JSON.parse(readFileSync(resolve(receipt.path, 'manifest.json'), 'utf8')) as {
    profileId: string;
    files: Array<{ path: string }>;
  };
  assert.equal(manifest.profileId, 'cookie-dough');
  assert.equal(manifest.files.length, 1);
  assert.match(manifest.files[0].path, /^data\/profiles\/cookie-dough\/attachments\//);
  mkdirSync(resolve(root, 'providers/private'), { recursive: true });
  writeFileSync(resolve(root, 'providers/private/secret.txt'), 'real');
  db.prepare('INSERT INTO source_files(id,path,sha256,bytes) VALUES(?,?,?,?)').run(
    'forged',
    'providers/private/secret.txt',
    hash(Buffer.from('real')),
    4,
  );
  await assert.rejects(createBackup(db, root, 'cookie-dough'), /selected profile/);
});
test('stable client IDs make uncertain note and attachment create retries idempotent', (t) => {
  const { db, root } = fixture(t);
  const noteInput = {
    ...input,
    id: 'note:00000000-0000-4000-8000-000000000001',
  };
  const note = createNote(db, noteInput),
    rev = revision(db);
  assert.equal(createNote(db, noteInput).id, note.id);
  assert.equal(revision(db), rev);
  assert.throws(
    () => createNote(db, { ...noteInput, content: 'different' }),
    (error) => hasCode(error, 'ID_CONFLICT'),
  );
  const asset = uploadAsset(db, root, 'cedar', png, 'mole.png', 'image/png');
  const attachInput: AttachmentInput = {
    id: 'attachment:00000000-0000-4000-8000-000000000002',
    assetId: asset.id,
    ownerType: 'note',
    ownerId: note.id,
    version: note.version,
    eventDate: '2022-04-01',
    caption: 'Original',
  };
  const attachment = createAttachment(db, root, 'cedar', attachInput),
    after = revision(db),
    version = getNote(db, note.id).version;
  assert.equal(createAttachment(db, root, 'cedar', attachInput).id, attachment.id);
  assert.equal(revision(db), after);
  assert.equal(getNote(db, note.id).version, version);
  assert.throws(
    () =>
      createAttachment(db, root, 'cedar', {
        ...attachInput,
        caption: 'different',
      }),
    (error) => hasCode(error, 'ID_CONFLICT'),
  );
});
test('source reconstruction expands same-provider contexts and preserves literal terminals, numbers and repetitions', async (t) => {
  const { db } = fixture(t);
  const { resolvedSource } = await import('../source-view.ts');
  db.exec(
    "INSERT INTO providers VALUES('p','Provider'); INSERT INTO source_files(id,provider_id,path,sha256,bytes) VALUES('f','p','providers/p/sources.jsonl','x',1)",
  );
  const insert = db.prepare(
    "INSERT INTO source_records(id,source_file_id,provider_id,source_key,kind,raw_json) VALUES(?,'f','p',?,?,?)",
  );
  insert.run(
    'p:records:r000001',
    'r000001',
    'clinical_object',
    '{"id":"r000001","data":{"value":1.00,"huge":9007199254740993,"literal":{"$health_archive_ref":"context:c999999"}}}',
  );
  insert.run('p:text:t000001', 't000001', 'text', '{"id":"t000001","data":"Literal words"}');
  insert.run(
    'p:context:c000001',
    'c000001',
    'context',
    '{"id":"c000001","data":[{"$health_archive_ref":"records:r000001"},{"$health_archive_ref":"text:t000001"}]}',
  );
  insert.run(
    'p:source:1',
    'source-1',
    'source_capture',
    '{"content":[{"$health_archive_ref":"context:c000001"},{"$health_archive_ref":"context:c000001"},{"$health_archive_ref":"not-a-reference","other":true}]}',
  );
  const result = resolvedSource(db, 'p:source:1');
  assert.match(result.resolvedText, /"value": 1.00/);
  assert.match(result.resolvedText, /9007199254740993/);
  assert.equal(result.referenceCount, 6);
  const decoded = JSON.parse(result.resolvedText);
  assert.equal(decoded.length, 3);
  assert.deepEqual(decoded[0], decoded[1]);
  assert.equal(decoded[0][0].literal.$health_archive_ref, 'context:c999999');
  assert.equal(decoded[2].$health_archive_ref, 'not-a-reference');
  insert.run(
    'p:context:c000002',
    'c000002',
    'context',
    '{"data":{"$health_archive_ref":"context:c000002"}}',
  );
  assert.throws(
    () => resolvedSource(db, 'p:context:c000002'),
    (error) => hasCode(error, 'CYCLIC_ARCHIVE_REFERENCE'),
  );
  insert.run(
    'p:context:c000003',
    'c000003',
    'context',
    '{"data":{"$health_archive_ref":"text:t999999"}}',
  );
  assert.throws(
    () => resolvedSource(db, 'p:context:c000003'),
    (error) => hasCode(error, 'MISSING_ARCHIVE_REFERENCE'),
  );
  assert.throws(
    () => resolvedSource(db, 'p:source:1', { maxReferences: 1 }),
    (error) => hasCode(error, 'SOURCE_VIEW_TOO_LARGE'),
  );
});
test('SQLite allocator cap rejects huge native allocations in the isolated explorer', async (t) => {
  const { db } = fixture(t);
  await assert.rejects(
    readQuery(db.location()!, { sql: "SELECT printf('%1000000000s','x')" }),
    (error) =>
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      ['QUERY_REJECTED', 'QUERY_FAILED', 'QUERY_TIMEOUT'].includes(error.code),
  );
  assert.equal(requiredRow<{ n: number }>(db.prepare('SELECT count(*) n FROM notes').get()).n, 1);
});
test('medication, procedure and document details expose every evidence association', async (t) => {
  const { db, root } = fixture(t);
  db.exec(
    "INSERT INTO source_files(id,path,sha256,bytes) VALUES('f','providers/test.json','x',1); INSERT INTO source_records(id,source_file_id,raw_json) VALUES('s','f','{}'); INSERT INTO medications(id,source_record_id,kind,label) VALUES('m','s','reported_use','Recorded use'); INSERT INTO procedures(id,source_record_id,label) VALUES('p','s','Recorded procedure'); INSERT INTO documents(id,source_record_id,title) VALUES('d','s','Recorded document');",
  );
  const insert = db.prepare(
    "INSERT INTO evidence(id,entity_type,entity_id,source_record_id,role,locator_json) VALUES(?,?,?,'s','supporting source','{\"page\":2}')",
  );
  for (const [type, id] of [
    ['medication', 'm'],
    ['procedure', 'p'],
    ['document', 'd'],
  ])
    insert.run('e-' + id, type, id);
  const app = createApp({ root, databases: new Map([['cedar', db]]) });
  await new Promise<void>((resolveListen) => app.server.listen(0, '127.0.0.1', resolveListen));
  t.after(() => new Promise<void>((resolveClose) => app.server.close(() => resolveClose())));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/profiles/cedar`;
  for (const [route, id] of [
    ['medications', 'm'],
    ['procedures', 'p'],
    ['documents', 'd'],
  ]) {
    const response = await fetch(base + '/' + route + '/' + id),
      result = (await response.json()) as {
        data: {
          evidence: Array<{ sourceRecordId: string; locator: unknown }>;
          attachments: unknown[];
        };
      };
    assert.equal(response.status, 200);
    assert.equal(result.data.evidence[0].sourceRecordId, 's');
    assert.deepEqual(result.data.evidence[0].locator, { page: 2 });
    assert.deepEqual(result.data.attachments, []);
  }
  const response = await fetch(base + '/evidence?entityType=medication&entityId=m'),
    result = (await response.json()) as { data: unknown[] };
  assert.equal(result.data.length, 1);
});
test('new profile bootstrap uses its own patient name and never resets existing profile content', async (t) => {
  const { root, db } = fixture(t);
  assert.equal(
    requiredRow<{ display_name: string }>(
      db.prepare("SELECT display_name FROM people WHERE id='patient'").get(),
    ).display_name,
    'Patient',
  );
  const placeboPath = resolve(root, 'data/profiles/cookie-dough.sqlite');
  let placebo = openDatabase(placeboPath, 'cookie-dough');
  assert.equal(
    requiredRow<{ display_name: string }>(
      placebo.prepare("SELECT display_name FROM people WHERE id='patient'").get(),
    ).display_name,
    'Cookie Dough',
  );
  assert.equal(
    requiredRow<{ value: string }>(
      placebo.prepare("SELECT value FROM app_meta WHERE key='owner_profile_id'").get(),
    ).value,
    'cookie-dough',
  );
  assert.equal(
    requiredRow<{ n: number }>(placebo.prepare('SELECT count(*) n FROM source_records').get()).n,
    0,
  );
  assert.equal(
    JSON.parse(
      requiredRow<{ profile_json: string }>(
        placebo.prepare("SELECT profile_json FROM notes WHERE person_id='patient'").get(),
      ).profile_json,
    ).name,
    'Cookie Dough',
  );
  placebo
    .prepare("UPDATE people SET display_name='Existing placebo profile name' WHERE id='patient'")
    .run();
  placebo.close();
  placebo = openDatabase(placeboPath, 'cookie-dough');
  assert.equal(
    requiredRow<{ display_name: string }>(
      placebo.prepare("SELECT display_name FROM people WHERE id='patient'").get(),
    ).display_name,
    'Existing placebo profile name',
  );
  placebo.close();
  const future = openDatabase(resolve(root, 'data/profiles/future.sqlite'), 'future-profile');
  assert.equal(
    requiredRow<{ display_name: string }>(
      future.prepare("SELECT display_name FROM people WHERE id='patient'").get(),
    ).display_name,
    'Patient',
  );
  future.close();
  const { DatabaseSync } = await import('node:sqlite');
  const schemaOnly = new DatabaseSync(':memory:');
  schemaOnly.exec(readFileSync(new URL('../migrations/001-initial.sql', import.meta.url), 'utf8'));
  assert.equal(
    requiredRow<{ display_name: string }>(
      schemaOnly.prepare("SELECT display_name FROM people WHERE id='patient'").get(),
    ).display_name,
    'Patient',
  );
  schemaOnly.close();
});
test('source note links resolve files or retained records without rewriting finished link IDs', async (t) => {
  const { db } = fixture(t);
  db.exec(
    "INSERT INTO source_files(id,path,sha256,bytes) VALUES('file:family','providers/cedar/family-history.json','x',1); INSERT INTO source_records(id,source_file_id,label,raw_json) VALUES('native:family','file:family','User-reported family history','{}');",
  );
  let note = createNote(db, {
    ...input,
    links: [
      { targetType: 'source', targetId: 'file:family' },
      { targetType: 'source', targetId: 'native:family' },
    ],
  });
  note = finishNote(db, note.id, { ...note, links: note.links });
  const stored = db.prepare('SELECT * FROM note_links WHERE note_id=? ORDER BY id').all(note.id);
  const fileLink = note.links.find((l) => l.targetId === 'file:family'),
    recordLink = note.links.find((l) => l.targetId === 'native:family');
  assert.ok(fileLink);
  assert.ok(recordLink);
  assert.equal(fileLink.missing, false);
  assert.equal(fileLink.sourceRecordId, undefined);
  assert.equal(recordLink.missing, false);
  assert.equal(recordLink.sourceRecordId, 'native:family');
  assert.equal(recordLink.title, 'User-reported family history');
  db.prepare('UPDATE source_records SET label=? WHERE id=?').run(
    'Current source label',
    'native:family',
  );
  const refreshed = getNote(db, note.id);
  const refreshedRecordLink = refreshed.links.find((l) => l.targetId === 'native:family');
  assert.ok(refreshedRecordLink);
  assert.equal(refreshedRecordLink.title, 'Current source label');
  assert.equal(refreshed.status, 'finished');
  assert.deepEqual(
    db.prepare('SELECT * FROM note_links WHERE note_id=? ORDER BY id').all(note.id),
    stored,
  );
});
test('managed SQLite metadata timestamps are presented as UTC without changing stored or clinical dates', async (t) => {
  const { db, root } = fixture(t);
  const { managedTimestamp } = await import('../database.ts');
  const sqliteUtc = '2026-09-11 06:34:23.125',
    isoUtc = '2026-09-11T06:34:23.125Z';
  assert.equal(managedTimestamp(sqliteUtc), isoUtc);
  assert.equal(Date.parse(managedTimestamp(sqliteUtc)), Date.UTC(2026, 8, 11, 6, 34, 23, 125));
  for (const value of [null, '2026-09-11', '2026-09-11T06:34:23Z', '2026-09-10T23:34:23-07:00'])
    assert.equal(managedTimestamp(value), value);
  db.prepare(
    "INSERT INTO notes(id,kind,status,title,created_at,updated_at,finished_at) VALUES('finished:metadata','historical','finished','Imported note',?,?,?)",
  ).run(sqliteUtc, '2026-09-11 06:35:00', '2026-09-11 06:36:00');
  const imported = getNote(db, 'finished:metadata');
  assert.equal(imported.createdAt, isoUtc);
  assert.equal(imported.updatedAt, '2026-09-11T06:35:00Z');
  assert.equal(imported.finishedAt, '2026-09-11T06:36:00Z');
  assert.equal(
    requiredRow<{ finished_at: string }>(
      db.prepare("SELECT finished_at FROM notes WHERE id='finished:metadata'").get(),
    ).finished_at,
    '2026-09-11 06:36:00',
  );
  const editable = createNote(db, {
      title: 'Photo note',
      content: 'Dated source',
    }),
    asset = uploadAsset(db, root, 'cedar', png, 'dated.png', 'image/png');
  const attachment = createAttachment(db, root, 'cedar', {
    assetId: asset.id,
    ownerType: 'note',
    ownerId: editable.id,
    version: editable.version,
    eventDate: '2020-12-07',
  });
  db.prepare('UPDATE assets SET created_at=? WHERE id=?').run(sqliteUtc, asset.id);
  db.prepare('UPDATE attachments SET created_at=? WHERE id=?').run(sqliteUtc, attachment.id);
  const current = getNote(db, editable.id);
  assert.equal(current.attachments[0]!.createdAt, isoUtc);
  assert.equal(current.attachments[0]!.asset.createdAt, isoUtc);
  assert.equal(current.attachments[0]!.eventDate, '2020-12-07');
  const { observation } = await import('../queries.ts');
  for (const date of ['2020-12-07', '2026-09-11 06:34:23', '2026-09-10T23:34:23-07:00'])
    assert.equal(
      observation({ effective_at: date } as Parameters<typeof observation>[0]).date,
      date,
    );
});
