import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase, type Database } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability, exportCuration, rebuildProfile } from '../portable.ts';
import { createNote, finishNote, getNote, relatedNotes } from '../notes.ts';
import { clinicalList, setMedicationCurrentStatus } from '../queries.ts';
import { visibilityState, setVisibility } from '../visibility.ts';
import { hash } from '../assets.ts';

// Exercise the feature boundary: visibility is personal history, while the
// clinical source and finished note remain identical through reconstruction.
test('archive, current medication use and finished-note backlinks survive a source-only rebuild together', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'health-archive-integration-'));
  const targetRoot = root + '-rebuilt';
  const paths = ensureProfileDirectories(root, 'cookie-dough');
  const db = openDatabase(paths.database, 'cookie-dough');
  let rebuilt: Database | undefined;
  t.after(() => {
    try {
      db.close();
    } catch {}
    try {
      rebuilt?.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  });
  const original =
    '{"label":"Synthetic LDL","value":123.000,"unit":"mg/dL","unmodeled":{"retained":true}}\n';
  const sourcePath = paths.relativeRoot + '/sources/synthetic.jsonl';
  writeFileSync(resolve(root, sourcePath), original);
  db.exec(
    "INSERT INTO providers VALUES('issuer','Synthetic clinician'),('capture','Synthetic acquisition source')",
  );
  db.prepare(
    "INSERT INTO source_files(id,provider_id,path,sha256,bytes) VALUES('file','capture',?,?,?)",
  ).run(sourcePath, hash(Buffer.from(original)), Buffer.byteLength(original));
  db.prepare(
    "INSERT INTO source_records(id,source_file_id,provider_id,raw_json,locator_json) VALUES('raw','file','capture',?,'{\"line\":1}')",
  ).run(original.trim());
  db.exec(`INSERT INTO test_types(id,label) VALUES('ldl','Synthetic LDL');
    INSERT INTO observations(id,test_type_id,source_record_id,provider_id,label,effective_at,date_precision,value_text,value_numeric,unit)
      VALUES('ldl-result','ldl','raw','issuer','Synthetic LDL','2026-08-24','day','123.000',123,'mg/dL');
    INSERT INTO medications(id,source_record_id,provider_id,kind,label,status)
      VALUES('med','raw','issuer','order','Synthetic medication','active');`);
  const draft = createNote(db, {
    kind: 'historical',
    title: 'Synthetic appointment',
    content: '# Discuss results\n- Review LDL',
    contentFormat: 'markdown',
    links: [{ targetType: 'observation', targetId: 'ldl-result' }],
  });
  const finished = finishNote(db, draft.id, {
    version: draft.version,
    title: draft.title,
    content: draft.content,
    contentFormat: 'markdown',
    links: [{ targetType: 'observation', targetId: 'ldl-result' }],
  });
  attachPersonalDurability(db, { root, profileId: 'cookie-dough' });
  exportCuration(db, root, 'cookie-dough');
  const immutableNote = db.prepare('SELECT * FROM notes WHERE id=?').get(finished.id);
  const rawRows = db.prepare('SELECT * FROM source_records ORDER BY id').all();
  const clinicalRows = db.prepare('SELECT * FROM medications ORDER BY id').all();
  setMedicationCurrentStatus(db, 'med', { status: 'current', version: 0, visibilityVersion: 0 });
  setVisibility(db, 'medication', 'med', { archived: true, version: 0, currentStatusVersion: 1 });
  setVisibility(db, 'note', finished.id, { archived: true, version: 0 });
  const comment = createNote(db, {
    title: 'Personal context',
    content: 'Keep this explanation with the original.',
    links: [
      { targetType: 'note', targetId: finished.id },
      { targetType: 'medication', targetId: 'med' },
    ],
  });
  setVisibility(db, 'note', finished.id, { archived: false, version: 1 });
  assert.equal(
    (clinicalList(db, 'medications', new URLSearchParams(), 'med') as { currentStatus: string })
      .currentStatus,
    'not_current',
  );
  assert.deepEqual(db.prepare('SELECT * FROM notes WHERE id=?').get(finished.id), immutableNote);
  exportCuration(db, root, 'cookie-dough');
  const receipt = rebuildProfile(root, 'cookie-dough', targetRoot);
  rebuilt = openDatabase(
    receipt.database || resolve(targetRoot, 'data/profiles/cookie-dough/db/database.sqlite'),
    'cookie-dough',
  );
  assert.deepEqual(rebuilt.prepare('SELECT * FROM source_records ORDER BY id').all(), rawRows);
  assert.deepEqual(rebuilt.prepare('SELECT * FROM medications ORDER BY id').all(), clinicalRows);
  assert.deepEqual(
    rebuilt.prepare('SELECT * FROM notes WHERE id=?').get(finished.id),
    immutableNote,
  );
  assert.equal(getNote(rebuilt, finished.id).status, 'finished');
  assert.equal(getNote(rebuilt, comment.id).content, comment.content);
  assert.equal(visibilityState(rebuilt, 'note', finished.id).history.length, 2);
  assert.equal(visibilityState(rebuilt, 'note', finished.id).archived, false);
  assert.equal(visibilityState(rebuilt, 'medication', 'med').archived, true);
  assert.equal(
    (
      clinicalList(rebuilt, 'medications', new URLSearchParams(), 'med') as {
        currentStatus: string;
      }
    ).currentStatus,
    'not_current',
  );
  assert.equal(readFileSync(resolve(targetRoot, sourcePath), 'utf8'), original);
  const backlinks = relatedNotes(rebuilt, 'note', finished.id);
  assert.ok(JSON.stringify(backlinks).includes(comment.id));
  assert.deepEqual(rebuilt.prepare('PRAGMA foreign_key_check').all(), []);
});
