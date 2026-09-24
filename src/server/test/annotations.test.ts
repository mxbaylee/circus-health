import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, revision } from '../database.ts';
import { createNote, saveNote, getNote, relatedNotes, linkTargets } from '../notes.ts';
import { uploadAsset, createAttachment, editAttachment } from '../assets.ts';
import type { Attachment } from '../../shared/api.ts';
import type { Note } from '../../shared/api.ts';

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve(tmpdir(), 'health-annotations-'));
  const db = openDatabase(resolve(root, 'data/profiles/cedar/database.sqlite'), 'cedar');
  const migration = db.prepare('SELECT max(version) AS n FROM schema_migrations').get();
  if (!migration || Number(migration.n) < 3)
    db.exec(
      readFileSync(new URL('../migrations/003-note-series-links.sql', import.meta.url), 'utf8'),
    );
  db.exec(`INSERT INTO source_files(id,path,sha256,bytes) VALUES('f','providers/test.json','x',1);
 INSERT INTO source_records(id,source_file_id,raw_json) VALUES('s','f','{}');
 INSERT INTO test_types(id,label,unit) VALUES('hdl','HDL cholesterol','mg/dL');
 INSERT INTO observations(id,test_type_id,source_record_id,label,value_text) VALUES('o','hdl','s','HDL cholesterol','54');
 INSERT INTO medications(id,source_record_id,kind,label) VALUES('m','s','order','Medicine');
 INSERT INTO procedures(id,source_record_id,label) VALUES('p','s','Procedure');
 INSERT INTO documents(id,source_record_id,title) VALUES('d','s','Provider note');`);
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, root };
}
function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
test('comments distinguish an individual result from a measurement, preserve link IDs, and filter targets', (t) => {
  const { db } = fixture(t);
  let series: Note = createNote(db, {
    title: 'My HDL context',
    links: [{ targetType: 'test_type', targetId: 'hdl' }],
  });
  const result = createNote(db, {
    title: 'This draw',
    links: [{ targetType: 'observation', targetId: 'o' }],
  });
  const original = series.links[0]!.id;
  series = saveNote(db, series.id, { ...series, content: 'More context' });
  assert.equal(series.links[0]!.id, original);
  assert.deepEqual(
    relatedNotes(db, 'test_type', 'hdl').map((n) => n.id),
    [series.id],
  );
  assert.deepEqual(
    relatedNotes(db, 'observation', 'o').map((n) => n.id),
    [result.id],
  );
  assert.equal(
    linkTargets(db, new URLSearchParams({ type: 'test_type', q: 'HDL' }))[0]!.targetType,
    'test_type',
  );
  assert.ok(
    linkTargets(db, new URLSearchParams({ type: 'person' })).every(
      (t) => t.targetType === 'person',
    ),
  );
  assert.throws(() => linkTargets(db, new URLSearchParams({ type: 'sql' })), /Unknown link type/);
  series = saveNote(db, series.id, { ...series, links: [] });
  assert.deepEqual(relatedNotes(db, 'test_type', 'hdl'), []);
});
test('Self uses the patient identity, allows annotations and attachments, rejects outgoing links and archiving', (t) => {
  const { db, root } = fixture(t);
  let self: Note = getNote(db, 'patient');
  assert.equal(self.id, 'person-note:self');
  assert.equal(self.isSelf, true);
  self = saveNote(db, self.id, {
    ...self,
    person: {
      ...self.person,
      fullName: 'Example Patient',
      pronouns: 'they/them',
      birthDate: '1990-03',
      lifeStatus: 'unknown',
    },
  });
  assert.equal(self.person.pronouns, 'they/them');
  assert.throws(
    () => saveNote(db, self.id, { ...self, links: [{ targetType: 'test_type', targetId: 'hdl' }] }),
    /Self/,
  );
  assert.throws(() => saveNote(db, self.id, { ...self, archived: true }), /Self/);
  const comment = createNote(db, {
    title: 'Patient context',
    links: [{ targetType: 'person', targetId: 'patient' }],
  });
  assert.equal(relatedNotes(db, 'note', self.id)[0]!.id, comment.id);
  const asset = uploadAsset(
    db,
    root,
    'cedar',
    Buffer.from('%PDF-1.4\nSample'),
    'info.pdf',
    'application/pdf',
  );
  createAttachment(db, root, 'cedar', {
    assetId: asset.id,
    ownerType: 'person',
    ownerId: 'patient',
    version: self.version,
  });
  assert.equal(getNote(db, self.id).attachments.length, 1);
  assert.throws(
    () => saveNote(db, self.id, { version: self.version, person: self.person }),
    /changed/,
  );
});
test('provider originals are immutable through attachment writes; a linked personal note is editable', (t) => {
  const { db, root } = fixture(t);
  const asset = uploadAsset(
    db,
    root,
    'cedar',
    Buffer.from('%PDF-1.4\nSample'),
    'info.pdf',
    'application/pdf',
  );
  for (const [type, id] of [
    ['observation', 'o'],
    ['medication', 'm'],
    ['procedure', 'p'],
    ['document', 'd'],
  ] satisfies Array<[Attachment['ownerType'], string]>) {
    const before = revision(db);
    assert.throws(
      () =>
        createAttachment(db, root, 'cedar', {
          assetId: asset.id,
          ownerType: type,
          ownerId: id,
        }),
      (e) => hasCode(e, 'READ_ONLY_RECORD'),
    );
    assert.equal(revision(db), before);
    db.prepare(
      'INSERT INTO attachments(id,asset_id,owner_type,owner_id,created_at) VALUES(?,?,?,?,?)',
    ).run('original-' + id, asset.id, type, id, '2026-01-01');
    assert.throws(
      () => editAttachment(db, 'original-' + id, { caption: 'Changed' }),
      (e) => hasCode(e, 'READ_ONLY_RECORD'),
    );
    assert.throws(
      () => editAttachment(db, 'original-' + id, {}, true),
      (e) => hasCode(e, 'READ_ONLY_RECORD'),
    );
  }
  const comment = createNote(db, {
    title: 'Photo annotation',
    links: [{ targetType: 'procedure', targetId: 'p' }],
  });
  createAttachment(db, root, 'cedar', {
    assetId: asset.id,
    ownerType: 'note',
    ownerId: comment.id,
    version: comment.version,
  });
  assert.equal(getNote(db, comment.id).attachments.length, 1);
});
test('person fields accept partial or unknown dates and preserve raw source facts', (t) => {
  const { db } = fixture(t);
  const p = createNote(db, {
    kind: 'person',
    title: 'Dad',
    person: {
      fullName: 'Example Parent',
      pronouns: 'he/him',
      birthDate: '1956',
      deathDate: '1993',
      lifeStatus: 'deceased',
      sourceRelative: { realName: 'Example Parent', other: 'retained' },
    },
  });
  assert.equal((p.person.sourceRelative as { other: string }).other, 'retained');
  assert.equal(p.title, 'Dad');
  for (const birthDate of ['2024-02-31', '2024-13', '00', 'tomorrow'])
    assert.throws(
      () => saveNote(db, p.id, { ...p, person: { ...p.person, birthDate } }),
      /date|YYYY/,
    );
  for (const birthDate of ['2024-02-29', 'unknown', '']) {
    const next = saveNote(db, p.id, { ...getNote(db, p.id), person: { ...p.person, birthDate } });
    assert.equal(next.person.birthDate, birthDate);
  }
});
test('related comments retain full Markdown bodies and saved format metadata', (t) => {
  const { db } = fixture(t),
    content = '# Heading\n\n- First\n- Second\n\n' + 'Context '.repeat(100);
  createNote(db, {
    title: 'Formatted context',
    content,
    textFormats: { content: 'markdown-v1' },
    links: [{ targetType: 'test_type', targetId: 'hdl' }],
  });
  const [comment] = relatedNotes(db, 'test_type', 'hdl');
  assert.ok(comment);
  assert.equal(comment.content, content);
  assert.deepEqual(comment.textFormats, { content: 'markdown-v1' });
});
