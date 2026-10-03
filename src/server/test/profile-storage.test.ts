import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { openDatabase, transaction, revision, type Database } from '../database.ts';
import { ensureProfileDirectories, profilePaths } from '../profile-storage.ts';
import {
  attachPersonalDurability,
  flushPersonal,
  personalDurabilityStatus,
  exportCuration,
  rebuildProfile,
  publishedPersonalLineage,
} from '../portable.ts';
import { createNote, saveNote, getNote } from '../notes.ts';
import { createAttachment, editAttachment, hash } from '../assets.ts';
import { createBackup, restoreBackup } from '../recovery.ts';
import { getSourceRecord } from '../queries.ts';

function fixture(t: TestContext, profileId = 'cedar') {
  const root = mkdtempSync(resolve(tmpdir(), 'health-profile-storage-'));
  const paths = ensureProfileDirectories(root, profileId);
  const db = openDatabase(paths.database, profileId);
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  return { root, paths, db, profileId };
}
type Fixture = ReturnType<typeof fixture>;
interface PortableRow {
  id?: string;
  raw_json?: string;
  content?: string;
  title?: string;
  source_record_id?: string;
  [key: string]: unknown;
}
interface PortableValue {
  tables: Record<string, PortableRow[]>;
}
interface PortableManifest {
  file: string;
  [key: string]: unknown;
}
function seed({ root, paths, db }: Pick<Fixture, 'root' | 'paths' | 'db'>) {
  const raw1 = '{"id":"one","value":1.0000,"large":12345678901234567890}';
  const raw2 = '{"id":"two","literal":{"$health_archive_ref":"records:r1"}}';
  const path = paths.relativeRoot + '/sources/issuer/records.jsonl';
  const bytes = Buffer.from(raw1 + '\r\n' + raw2 + '\n');
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), bytes);
  db.exec(
    "INSERT INTO providers VALUES('issuer','Explicit issuer'); INSERT INTO manual_batches(id,title,status,created_at) VALUES('batch','Reviewed source','verified','2026-09-10')",
  );
  db.prepare(
    "INSERT INTO source_files(id,provider_id,path,sha256,bytes,batch_id) VALUES('file','issuer',?,?,?,'batch')",
  ).run(path, hash(bytes), bytes.length);
  const insert = db.prepare(
    "INSERT INTO source_records(id,source_file_id,provider_id,source_key,raw_json,locator_json,batch_id) VALUES(?,'file','issuer',?,?,?,'batch')",
  );
  insert.run('record1', 'one', raw1, '{"line":1}');
  insert.run('record2', 'two', raw2, '{"line":2}');
  insert.run('unmatched', 'inline', '{ "original": 0.50000, "unmodeled": [true, null] }', '{}');
  db.exec(
    "INSERT INTO test_types(id,label) VALUES('measurement','Retained measurement'); INSERT INTO reports(id,source_record_id,title) VALUES('report','record1','Original report'); INSERT INTO observations(id,test_type_id,source_record_id,report_id,label,value_text,value_numeric) VALUES('result','measurement','record1','report','Original result','1.0000',1); INSERT INTO medications(id,source_record_id,kind,label) VALUES('med','record1','order','Original order'); INSERT INTO procedures(id,source_record_id,label,category) VALUES('procedure','record1','Original surgery','surgery'); INSERT INTO documents(id,source_record_id,title,text_content) VALUES('document','record2','Original document','Words retained'); INSERT INTO record_relationships(id,from_record_id,to_record_id,relation,status,rationale) VALUES('relationship','record1','record2','related','accepted','Reviewed evidence'); INSERT INTO evidence(id,entity_type,entity_id,source_record_id) VALUES('evidence-result','observation','result','record1')",
  );
  return { raw1, raw2, path };
}
function allRows(db: Database) {
  return Object.fromEntries(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((table) => {
        const name = String(table.name);
        let rows = db.prepare(`SELECT * FROM "${name}"`).all();
        if (name === 'app_meta')
          rows = rows.filter(
            (row) => !String(row.key).startsWith('personal_') && row.key !== 'curation_revision',
          );
        return [name, rows.map((row) => JSON.stringify(row)).sort()];
      }),
  );
}
function latest(directory: string): { manifest: PortableManifest; value: PortableValue } {
  const manifest = JSON.parse(
    readFileSync(resolve(directory, 'current.json'), 'utf8'),
  ) as PortableManifest;
  return {
    manifest,
    value: JSON.parse(readFileSync(resolve(directory, manifest.file), 'utf8')) as PortableValue,
  };
}

test('portable rebuild uses originals plus explicit curation and latest personal state without the old database', (t) => {
  for (const profileId of ['cedar', 'cookie-dough', 'orchid']) {
    const f = fixture(t, profileId),
      { db, root, paths } = f;
    const originals = seed(f);
    const mom = createNote(db, {
      kind: 'person',
      title: 'Mom',
      person: { name: 'Mom', unknownPersonal: { nested: [1, 'retained'] } },
    });
    const removed = createNote(db, { title: 'Editable note later removed' });
    let draft = createNote(db, {
      kind: 'historical',
      title: 'Visit preparation',
      content: 'Before',
      links: [
        { targetType: 'person', targetId: mom.personId },
        { targetType: 'source', targetId: 'record1' },
      ],
    });
    const assetPath = paths.relativeRoot + '/attachments/original.pdf';
    const assetBytes = Buffer.from('%PDF-original retained bytes');
    writeFileSync(resolve(root, assetPath), assetBytes);
    db.prepare(
      "INSERT INTO assets(id,original_name,stored_path,mime_type,bytes,sha256,created_at) VALUES('asset','original.pdf',?,'application/pdf',?,?,'2026-09-10')",
    ).run(assetPath, assetBytes.length, hash(assetBytes));
    const attachment = createAttachment(db, root, profileId, {
      ownerType: 'note',
      ownerId: draft.id,
      version: draft.version,
      assetId: 'asset',
      caption: 'Original caption',
    });
    draft = getNote(db, draft.id);
    db.prepare(
      "INSERT INTO evidence(id,entity_type,entity_id,source_record_id) VALUES('personal-evidence','note',?,'record2')",
    ).run(draft.id);
    const attached = attachPersonalDurability(db, { portableSnapshots: true, root, profileId });
    assert.equal(attached.dirty, false);
    const receipt = exportCuration(db, root, profileId);
    assert.deepEqual(receipt.rawJson, { referenced: 2, verbatim: 1 });
    const curatedBefore = readFileSync(resolve(paths.curation, 'current.json'), 'utf8');
    const rawInCuration = latest(paths.curation).value.tables.source_records;
    assert.equal(rawInCuration.find((r) => r.id === 'record1')?.raw_json, undefined);
    assert.equal(
      rawInCuration.find((r) => r.id === 'unmatched')?.raw_json,
      '{ "original": 0.50000, "unmodeled": [true, null] }',
    );
    transaction(db, () => db.prepare('DELETE FROM notes WHERE id=?').run(removed.id));
    saveNote(db, mom.id, {
      version: mom.version,
      title: 'Mom now',
      person: { ...mom.person, updated: 'preserved' },
    });
    editAttachment(db, attachment.id, { version: draft.version }, true);
    draft = getNote(db, draft.id);
    draft = saveNote(db, draft.id, {
      version: draft.version,
      content: 'During visit',
      links: [{ targetType: 'person', targetId: mom.personId }],
    });
    transaction(db, () => {
      db.prepare(
        "INSERT INTO note_links(id,note_id,target_type,target_id) VALUES('whole-series',?,'test_type','measurement')",
      ).run(draft.id);
      db.prepare(
        "UPDATE notes SET status='finished',finished_at='2026-09-11T01:00:00Z' WHERE id=?",
      ).run(draft.id);
    });
    assert.equal(
      readFileSync(resolve(paths.curation, 'current.json'), 'utf8'),
      curatedBefore,
      'autosaves do not rewrite clinical curation or the raw corpus',
    );
    assert.equal(
      latest(paths.personal).value.tables.assets.length,
      1,
      'unlinked original remains indexed',
    );
    assert.equal(
      latest(paths.personal).value.tables.attachments.length,
      0,
      'unlink is durable, not resurrected from old snapshots',
    );
    assert.ok(readdirSync(resolve(paths.personal, 'snapshots')).length >= 5);
    const expected = allRows(db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
    rmSync(paths.database);
    rmSync(paths.database + '-wal', { force: true });
    rmSync(paths.database + '-shm', { force: true });
    const target = resolve(root, 'rebuilt');
    mkdirSync(target);
    const result = rebuildProfile(root, profileId, target);
    assert.equal(result.files, 2);
    const restored = new DatabaseSync(result.database, {
      enableForeignKeyConstraints: true,
    });
    assert.deepEqual(allRows(restored), expected);
    assert.equal(
      restored.prepare("SELECT raw_json FROM source_records WHERE id='record1'").get()?.raw_json,
      originals.raw1,
    );
    assert.equal(
      restored.prepare("SELECT raw_json FROM source_records WHERE id='record2'").get()?.raw_json,
      originals.raw2,
    );
    assert.equal(
      restored.prepare('SELECT title FROM notes WHERE id=?').get(mom.id)?.title,
      'Mom now',
    );
    assert.equal(restored.prepare('SELECT COUNT(*) n FROM attachments').get()?.n, 0);
    assert.throws(
      () => restored.prepare("UPDATE notes SET content='rewrite' WHERE id=?").run(draft.id),
      /Finished notes/,
    );
    assert.throws(
      () => restored.prepare('DELETE FROM note_links WHERE note_id=?').run(draft.id),
      /Finished note links/,
    );
    assert.deepEqual(readFileSync(resolve(target, assetPath)), assetBytes);
    restored.close();
  }
});

test('startup retries the committed dirty revision after a failed write and connection loss', (t) => {
  const f = fixture(t),
    { root, paths } = f;
  let db = f.db;
  attachPersonalDurability(db, { portableSnapshots: true, root, profileId: 'cedar' });
  attachPersonalDurability(db, {
    portableSnapshots: true,
    root,
    profileId: 'cedar',
    writer() {
      throw new Error('Disk unavailable');
    },
  });
  const note = createNote(db, {
    title: 'Committed before restart',
    content: 'Keep all these words',
  });
  const savedRevision = revision(db);
  db.close();
  db = openDatabase(paths.database, 'cedar');
  t.after(() => db.close());
  assert.equal(personalDurabilityStatus(db).configured, false);
  assert.equal(personalDurabilityStatus(db).dirty, true);
  assert.equal(revision(db), savedRevision);
  const status = attachPersonalDurability(db, {
    portableSnapshots: true,
    root,
    profileId: 'cedar',
  });
  assert.equal(status.dirty, false);
  assert.equal(status.persistedRevision, savedRevision);
  assert.equal(
    latest(paths.personal).value.tables.notes?.find((row) => row.id === note.id)?.content,
    'Keep all these words',
  );
});

test('staging rejects semantically incomplete or broken portable rows even with matching generation checksums', (t) => {
  const f = fixture(t),
    { db, root, paths } = f;
  seed(f);
  attachPersonalDurability(db, { root, profileId: 'cedar', portableSnapshots: true });
  exportCuration(db, root, 'cedar');
  const original = latest(paths.curation);
  function replace(value: PortableValue) {
    const bytes = Buffer.from(JSON.stringify(value));
    writeFileSync(resolve(paths.curation, original.manifest.file), bytes);
    writeFileSync(
      resolve(paths.curation, 'current.json'),
      JSON.stringify({
        ...original.manifest,
        sha256: hash(bytes),
        bytes: bytes.length,
      }),
    );
  }
  let changed = structuredClone(original.value);
  delete changed.tables.medications;
  replace(changed);
  const target = resolve(root, 'invalid-target');
  assert.throws(() => rebuildProfile(root, 'cedar', target), /Incomplete portable tables/);
  assert.equal(existsSync(target), false);
  changed = structuredClone(original.value);
  changed.tables.observations![0]!.source_record_id = 'missing-source';
  replace(changed);
  assert.throws(() => rebuildProfile(root, 'cedar', target), /foreign-key/);
  assert.equal(existsSync(target), false);
  assert.equal(
    readdirSync(root).some((name) => name.includes('.rebuild-')),
    false,
  );
  assert.equal(db.prepare('SELECT COUNT(*) n FROM observations').get()?.n, 1);
  const note = createNote(db, { title: 'Bad external target' });
  transaction(db, () =>
    db
      .prepare(
        "INSERT INTO note_links(id,note_id,target_type,target_id) VALUES('missing-measurement',?,'test_type','not-present')",
      )
      .run(note.id),
  );
  exportCuration(db, root, 'cedar');
  assert.throws(() => rebuildProfile(root, 'cedar', target), /note-link target missing/);
  assert.equal(existsSync(target), false);
});

test('portable publication holds a SQLite write lock across capture and file publication', (t) => {
  const f = fixture(t),
    { db, root, paths } = f;
  seed(f);
  const other = new DatabaseSync(paths.database);
  other.exec('PRAGMA busy_timeout=0');
  t.after(() => other.close());
  let phase = 'attach',
    witnessed = new Set();
  attachPersonalDurability(db, {
    portableSnapshots: true,
    root,
    profileId: 'cedar',
    writer(path, bytes) {
      assert.throws(
        () => other.prepare("UPDATE app_meta SET value=value WHERE key='revision'").run(),
        /locked/,
      );
      witnessed.add(phase);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    },
  });
  phase = 'personal edit';
  createNote(db, { title: 'Atomic snapshot' });
  phase = 'curation';
  exportCuration(db, root, 'cedar');
  assert.deepEqual([...witnessed], ['attach', 'personal edit', 'curation']);
  assert.doesNotThrow(() =>
    other.prepare("UPDATE app_meta SET value=value WHERE key='revision'").run(),
  );
});

test('a post-commit file failure leaves a recoverable dirty marker and retries without claiming SQLite rolled back', (t) => {
  const { root, paths, db } = fixture(t);
  seed({ root, paths, db });
  attachPersonalDurability(db, { portableSnapshots: true, root, profileId: 'cedar' });
  const note = createNote(db, { title: 'Before failure' });
  const previous = readFileSync(resolve(paths.personal, 'current.json'), 'utf8');
  let writes = 0;
  attachPersonalDurability(db, {
    portableSnapshots: true,
    root,
    profileId: 'cedar',
    writer() {
      writes++;
      throw new Error('Simulated disk full');
    },
  });
  const edited = saveNote(db, note.id, {
    version: note.version,
    title: 'Saved in SQLite',
  });
  assert.equal(edited.title, 'Saved in SQLite');
  const status = personalDurabilityStatus(db);
  assert.equal(status.dirty, true);
  assert.equal(status.lastError, 'Simulated disk full');
  assert.ok(status.persistedRevision !== null && status.persistedRevision < status.revision);
  assert.equal(readFileSync(resolve(paths.personal, 'current.json'), 'utf8'), previous);
  assert.ok(writes >= 2);
  assert.throws(() => exportCuration(db, root, 'cedar'), /must be durable/);
  const retried = attachPersonalDurability(db, {
    portableSnapshots: true,
    root,
    profileId: 'cedar',
  });
  assert.equal(retried.dirty, false);
  assert.equal(retried.lastError, null);
  assert.equal(retried.persistedRevision, revision(db));
  assert.equal(
    latest(paths.personal).value.tables.notes?.find((r) => r.id === note.id)?.title,
    'Saved in SQLite',
  );
  const beforeRevision = revision(db),
    beforePointer = readFileSync(resolve(paths.personal, 'current.json'), 'utf8');
  assert.throws(
    () =>
      transaction(db, () => {
        throw new Error('before commit');
      }),
    /before commit/,
  );
  assert.equal(revision(db), beforeRevision);
  assert.equal(readFileSync(resolve(paths.personal, 'current.json'), 'utf8'), beforePointer);
});

test('an older restored database cannot overwrite newer portable personal history even after more edits', (t) => {
  const f = fixture(t),
    { db, root, paths } = f;
  seed(f);
  attachPersonalDurability(db, { root, profileId: 'cedar', portableSnapshots: true });
  exportCuration(db, root, 'cedar');
  const note = createNote(db, { title: 'Latest personal history' });
  const pointer = readFileSync(resolve(paths.personal, 'current.json'), 'utf8');
  db.prepare("UPDATE app_meta SET value='0' WHERE key='revision'").run();
  const status = attachPersonalDurability(db, {
    portableSnapshots: true,
    root,
    profileId: 'cedar',
  });
  assert.equal(status.dirty, true);
  assert.equal(status.conflicted, true);
  assert.ok(status.lastError);
  assert.match(status.lastError, /newer than or conflicts/);
  let current = getNote(db, note.id);
  for (let i = 0; i < 4; i++)
    assert.throws(
      () =>
        saveNote(db, note.id, {
          version: current.version,
          title: 'Unreviewed older branch ' + i,
        }),
      /conflicts/,
    );
  assert.equal(readFileSync(resolve(paths.personal, 'current.json'), 'utf8'), pointer);
  assert.equal(personalDurabilityStatus(db).conflicted, true);
  assert.throws(() => exportCuration(db, root, 'cedar'), /newer than or conflicts/);
  const recovered = rebuildProfile(root, 'cedar', resolve(root, 'from-newer-portable'));
  assert.ok(recovered.database);
  const rebuilt = openDatabase(recovered.database, 'cedar');
  assert.equal(getNote(rebuilt, note.id).title, 'Latest personal history');
  assert.equal(personalDurabilityStatus(rebuilt).conflicted, false);
  rebuilt.close();
});

test('staged rebuild rejects damaged sources, damaged generations, cross-profile files and live destinations', (t) => {
  const { root, paths, db } = fixture(t);
  const original = seed({ root, paths, db });
  attachPersonalDurability(db, { root, profileId: 'cedar', portableSnapshots: true });
  exportCuration(db, root, 'cedar');
  assert.throws(() => rebuildProfile(root, 'cedar', root), /never overwritten/);
  const bytes = readFileSync(resolve(root, original.path));
  writeFileSync(resolve(root, original.path), 'changed');
  const target = resolve(root, 'blocked-rebuild');
  assert.throws(() => rebuildProfile(root, 'cedar', target), /checksum/);
  assert.equal(existsSync(target), false);
  writeFileSync(resolve(root, original.path), bytes);
  const generation = latest(paths.personal);
  writeFileSync(resolve(paths.personal, generation.manifest.file), '{}');
  assert.throws(() => rebuildProfile(root, 'cedar', target), /checksum/);
  writeFileSync(
    resolve(paths.personal, generation.manifest.file),
    JSON.stringify(generation.value, null, 2) + '\n',
  );
  flushPersonal(db);
  db.prepare("UPDATE source_files SET path='data/profiles/cookie-dough/sources/leak.json'").run();
  assert.throws(() => exportCuration(db, root, 'cedar'), /outside the selected profile/);
});

test('modern backup restores the symmetric layout and can rebuild again after deleting its restored database', async (t) => {
  const { root, paths, db } = fixture(t, 'cookie-dough');
  seed({ root, paths, db });
  attachPersonalDurability(db, { portableSnapshots: true, root, profileId: 'cookie-dough' });
  createNote(db, { title: 'Fictional note', content: 'Saved personal text' });
  const expected = allRows(db);
  const receipt = await createBackup(db, root, 'cookie-dough');
  const manifest = JSON.parse(readFileSync(resolve(receipt.path, 'manifest.json'), 'utf8')) as {
    format: string;
    profileSources: Array<{ path: string }>;
    files: Array<{ path: string }>;
  };
  assert.equal(manifest.format, 'circus-health-backup-v2');
  const published = [...publishedPersonalLineage(root, 'cookie-dough')];
  for (const generation of published)
    assert.ok(
      manifest.profileSources.some(
        (file) => file.path === `${paths.relativeRoot}/personal/${generation.manifest.file}`,
      ),
    );
  assert.ok(manifest.profileSources.length >= published.length + 4);
  assert.ok(
    manifest.profileSources.some((file) => file.path.includes('/curation/history-receipts/')),
  );
  assert.equal(
    manifest.files.every((file) => file.path.startsWith(paths.relativeRoot + '/')),
    true,
  );
  const destination = resolve(root, 'restored');
  restoreBackup(receipt.path, destination);
  const restoredPaths = profilePaths(destination, 'cookie-dough');
  const restored = new DatabaseSync(restoredPaths.database, { readOnly: true });
  assert.deepEqual(allRows(restored), expected);
  restored.close();
  rmSync(restoredPaths.database);
  const again = rebuildProfile(destination, 'cookie-dough', resolve(root, 'rebuilt-from-backup'));
  const rebuilt = new DatabaseSync(again.database, { readOnly: true });
  assert.deepEqual(allRows(rebuilt), expected);
  rebuilt.close();
});

test('working databases live inside the dedicated profile db directory', (t) => {
  const f = fixture(t, 'cookie-dough');
  assert.equal(f.paths.database, resolve(f.root, 'data/profiles/cookie-dough/db/database.sqlite'));
  assert.equal(f.paths.databaseDirectory, resolve(f.root, 'data/profiles/cookie-dough/db'));
  assert.equal(existsSync(f.paths.databaseDirectory), true);
  assert.equal(existsSync(resolve(f.paths.root, 'database.sqlite')), false);
});

test('source relationship API order survives a fresh database rebuild', (t) => {
  const f = fixture(t);
  seed(f);
  f.db.prepare("DELETE FROM record_relationships WHERE id='relationship'").run();
  const insert = f.db.prepare(
    'INSERT INTO record_relationships(id,from_record_id,to_record_id,relation,status,rationale) VALUES(?,?,?,?,?,?)',
  );
  for (const [id, relation] of [
    ['relationship-z', 'fictional-z'],
    ['relationship-a', 'fictional-a'],
    ['relationship-m', 'fictional-m'],
    ['relationship-b', 'fictional-b'],
  ])
    insert.run(id, 'record1', 'record2', relation, 'accepted', 'Fictional reviewed evidence');
  const expected = ['relationship-a', 'relationship-b', 'relationship-m', 'relationship-z'];
  assert.deepEqual(
    (getSourceRecord(f.db, 'record1').relationships as Array<{ id: string }>).map(({ id }) => id),
    expected,
  );
  const reference = getSourceRecord(f.db, 'record1', { fileView: 'reference' });
  assert.equal(reference.fileView, 'reference');
  assert.equal(reference.file?.detailsIncluded, false);
  assert.equal(Object.hasOwn(reference.file!, 'details'), false);
  assert.deepEqual(
    (reference.relationships as Array<{ id: string }>).map(({ id }) => id),
    expected,
  );

  attachPersonalDurability(f.db, { portableSnapshots: true, root: f.root, profileId: f.profileId });
  exportCuration(f.db, f.root, f.profileId);
  const target = resolve(f.root, 'relationship-order-rebuilt');
  const rebuilt = rebuildProfile(f.root, f.profileId, target);
  const rebuiltDb = openDatabase(rebuilt.database, f.profileId);
  try {
    assert.deepEqual(
      (getSourceRecord(rebuiltDb, 'record1').relationships as Array<{ id: string }>).map(
        ({ id }) => id,
      ),
      expected,
    );
    const rebuiltReference = getSourceRecord(rebuiltDb, 'record1', { fileView: 'reference' });
    assert.deepEqual(rebuiltReference, reference);
    assert.equal(Object.hasOwn(rebuiltReference.file!, 'details'), false);
  } finally {
    rebuiltDb.close();
  }
});
