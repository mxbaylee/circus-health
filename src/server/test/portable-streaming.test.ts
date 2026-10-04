import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  loadPortable,
  openPortableRows,
  writePortableSources,
  projectPortableDatabase,
  logicalDatabaseHash,
  type CompleteLoadedPortable,
  type PortableManifest,
  type PortableSnapshot,
} from '../portable.ts';
import { createPortableWorkCounters, withPortableWork } from '../portable-work.ts';
import { createBackup, restoreBackup } from '../recovery.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
function fixture(t: TestContext, count = 512) {
  const root = mkdtempSync(resolve(tmpdir(), 'portable-streaming-')),
    profileId = 'cedar';
  const paths = ensureProfileDirectories(root, profileId),
    db = openDatabase(paths.database, profileId);
  t.after(() => {
    try {
      db.close();
    } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  const records = [
    '{ "unknown": "Fictional 🪁 wording", "amount": 1.0000 }',
    '{"other":"escaped \\n literal","array":[3,2,1]}',
  ];
  const bytes = Buffer.from(records.join('\r\n') + '\r\n'),
    path = paths.relativeRoot + '/sources/fictional.jsonl';
  writeFileSync(resolve(root, path), bytes);
  db.prepare('INSERT INTO source_files(id,path,sha256,bytes,details_json) VALUES(?,?,?,?,?)').run(
    'source',
    path,
    hash(bytes),
    bytes.length,
    '{"unknown":{"kept":[2,1]}}',
  );
  for (const [ordinal, raw] of records.entries())
    db.prepare(
      'INSERT INTO source_records(id,source_file_id,raw_json,locator_json) VALUES(?,?,?,?)',
    ).run('record-' + ordinal, 'source', raw, JSON.stringify({ line: ordinal + 1 }));
  const insert = db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)');
  db.exec('BEGIN');
  for (let i = 0; i < count; i++)
    insert.run(
      'fictional-retained-' + String(i).padStart(5, '0'),
      JSON.stringify({ opaque: 'x'.repeat(2048), ordinal: i }),
    );
  db.exec('COMMIT');
  const writeWork = createPortableWorkCounters();
  withPortableWork(writeWork, () =>
    writePortableSources(db, root, profileId, root, { onFile: () => {} }),
  );
  return { root, profileId, paths, db, records, path, writeWork };
}
function editGeneration(f: ReturnType<typeof fixture>, edit: (value: PortableSnapshot) => void) {
  const pointer = resolve(f.paths.curation, 'current.json'),
    manifest = JSON.parse(readFileSync(pointer, 'utf8')) as PortableManifest;
  const file = resolve(f.paths.curation, manifest.file),
    value = JSON.parse(readFileSync(file, 'utf8')) as PortableSnapshot;
  edit(value);
  const bytes = Buffer.from(JSON.stringify(value));
  writeFileSync(file, bytes);
  writeFileSync(pointer, JSON.stringify({ ...manifest, bytes: bytes.length, sha256: hash(bytes) }));
}

test('selected portable rows match legacy logical evidence and projection with fixed read/output windows', (t) => {
  const f = fixture(t),
    full = loadPortable(f.root, f.profileId) as CompleteLoadedPortable;
  const work = createPortableWorkCounters(),
    selected = withPortableWork(work, () => openPortableRows(f.root, f.profileId));
  try {
    for (const [name, expected] of Object.entries(full.rows))
      assert.deepEqual([...selected.rows(name)], expected, name);
    assert.equal(selected.originalCount, full.originals.size);
    assert.deepEqual(
      [...selected.rows('source_records')].map((row) => row.raw_json),
      f.records,
    );
    const result = projectPortableDatabase(
      resolve(f.root, 'rebuilt.sqlite'),
      f.profileId,
      selected,
    );
    const legacy = projectPortableDatabase(resolve(f.root, 'legacy.sqlite'), f.profileId, full);
    assert.equal(result.logicalSha256, legacy.logicalSha256);
    assert.ok(work.generationRows > 512);
    assert.ok(work.generationBytes > work.maxRowBytes * 100);
    assert.equal(work.maxReadBufferBytes, 64 * 1024);
    assert.ok(work.maxRowBytes < 4096);
    assert.ok(f.writeWork.outputBytes > f.writeWork.maxOutputChunkBytes * 100);
    assert.ok(f.writeWork.maxOutputChunkBytes < 4096);
    assert.equal(
      f.writeWork.lineIndexReadBytes,
      Buffer.byteLength(f.records.join('\r\n') + '\r\n'),
    );
    assert.equal(f.writeWork.rangeReadCalls, 2);
    assert.equal(work.rangeReadCalls, 2);
    assert.equal(
      work.rangeReadBytes,
      f.records.reduce((sum, row) => sum + Buffer.byteLength(row), 0),
    );
  } finally {
    selected.close();
    selected.close();
  }
  assert.throws(() => [...selected.rows('app_meta')]);
});

test('doubling generation inventory doubles traversal without increasing the logical row/read window', (t) => {
  const small = fixture(t, 512),
    large = fixture(t, 1024);
  const counters = [small, large].map((f) => {
    const work = createPortableWorkCounters();
    withPortableWork(work, () => {
      const selected = openPortableRows(f.root, f.profileId);
      selected.close();
    });
    return work;
  });
  assert.equal(counters[1]!.generationRows - counters[0]!.generationRows, 512);
  assert.ok(counters[1]!.generationBytes < counters[0]!.generationBytes * 2.1);
  assert.equal(counters[1]!.maxReadBufferBytes, counters[0]!.maxReadBufferBytes);
  assert.ok(counters[1]!.maxRowBytes <= counters[0]!.maxRowBytes + 1);
});

test('selected range authentication refuses re-signed corrupt references and generation/original changes', async (t) => {
  await t.test('canonical range hash', (t) => {
    const f = fixture(t, 4);
    editGeneration(f, (value) => {
      (value.tables.source_records![0]!.raw_source as Record<string, unknown>).sha256 = '0'.repeat(
        64,
      );
    });
    assert.throws(
      () => openPortableRows(f.root, f.profileId),
      /Canonical raw JSON reference checksum/,
    );
  });
  await t.test('selected generation digest', (t) => {
    const f = fixture(t, 4),
      pointer = resolve(f.paths.curation, 'current.json');
    const manifest = JSON.parse(readFileSync(pointer, 'utf8')) as PortableManifest;
    writeFileSync(pointer, JSON.stringify({ ...manifest, sha256: '0'.repeat(64) }));
    assert.throws(() => openPortableRows(f.root, f.profileId), /generation checksum/);
  });
  await t.test('original digest', (t) => {
    const f = fixture(t, 4);
    writeFileSync(resolve(f.root, f.path), 'changed');
    assert.throws(() => openPortableRows(f.root, f.profileId), /Original checksum/);
  });
  await t.test('metadata inventory duplicate', (t) => {
    const f = fixture(t, 4);
    editGeneration(f, (value) => {
      value.tables.app_meta!.push(value.tables.app_meta![0]!);
    });
    assert.throws(() => openPortableRows(f.root, f.profileId), /metadata|duplicate/i);
  });
});

test('streamed backup/restore preserves unknown metadata and exact canonical lexical originals', async (t) => {
  const f = fixture(t, 512),
    work = createPortableWorkCounters(),
    backup = await withPortableWork(work, () => createBackup(f.db, f.root, f.profileId)),
    target = resolve(f.root, 'restored');
  assert.ok(
    work.outputBytes >=
      statSync(resolve(backup.path, 'portable.json')).size +
        statSync(resolve(backup.path, 'manifest.json')).size,
  );
  assert.ok(work.maxOutputChunkBytes < 4096);
  assert.ok(work.fileCopyBytes > 0);
  assert.ok(work.fileHashBytes > 0);
  const restored = restoreBackup(backup.path, target),
    selected = openPortableRows(target, f.profileId);
  try {
    assert.equal(restored.files, 1);
    assert.deepEqual(
      [...selected.rows('source_records')].map((row) => row.raw_json),
      f.records,
    );
    const stored = [...selected.rows('app_meta')].find(
      (row) => row.key === 'fictional-retained-00511',
    );
    assert.equal(
      stored?.value,
      f.db.prepare('SELECT value FROM app_meta WHERE key=?').get('fictional-retained-00511')?.value,
    );
  } finally {
    selected.close();
  }
});

test('streamed logical hash retains the old JavaScript UTF-16 sort oracle', (t) => {
  const f = fixture(t, 4);
  f.db.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional:sort:\u{10000}', 'astral');
  f.db.prepare('INSERT INTO app_meta VALUES(?,?)').run('fictional:sort:\ue000', 'bmp');
  const expected = createHash('sha256');
  for (const { name } of f.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '__record_*' ORDER BY name",
    )
    .all()) {
    expected.update(String(name) + '\n');
    const sql = 'SELECT * FROM "' + String(name).replaceAll('"', '""') + '"';
    for (const row of f.db
      .prepare(sql)
      .all()
      .map((row) => JSON.stringify(row))
      .sort())
      expected.update(row + '\n');
  }
  assert.equal(logicalDatabaseHash(f.db), expected.digest('hex'));
});

test('streamed export retains older-schema readonly snapshot table defaults', (t) => {
  const f = fixture(t, 4);
  f.db.exec(
    'PRAGMA foreign_keys=OFF; DROP TABLE medication_preferences; DROP TABLE visibility_events; DELETE FROM schema_migrations WHERE version>=4',
  );
  const readonly = new DatabaseSync(f.paths.database, { readOnly: true });
  try {
    writePortableSources(readonly, f.root, f.profileId, f.root, { onFile: () => {} });
  } finally {
    readonly.close();
  }
  const selected = openPortableRows(f.root, f.profileId);
  try {
    assert.equal(selected.personal.value.schemaVersion, 3);
    assert.deepEqual([...selected.rows('medication_preferences')], []);
    assert.deepEqual([...selected.rows('visibility_events')], []);
  } finally {
    selected.close();
  }
});

test('unknown generation tables fail before building an unbounded table-name inventory', (t) => {
  const f = fixture(t, 4);
  editGeneration(f, (value) => {
    value.tables.unknown_table = [];
  });
  assert.throws(() => openPortableRows(f.root, f.profileId), /Unknown portable table/);
});
