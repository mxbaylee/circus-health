import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  loadPortable,
  openPortableRows,
  writePortableSources,
  writePortableSourcesAsync,
  type PortableStepWork,
  projectPortableDatabase,
  projectPortableDatabaseBounded,
  logicalDatabaseHash,
  publishedPersonalHeaders,
  type CompleteLoadedPortable,
  type PortableManifest,
  type PortableSnapshot,
  DURABLE_OUTPUT_BUFFER_BYTES,
} from '../portable.ts';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createPortableWorkCounters, withPortableWork } from '../portable-work.ts';
import { createBackup, restoreBackup } from '../recovery.ts';
import { createNote } from '../notes.ts';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
test('selected personal header traversal spools large rows without returning their values', (t) => {
  const root = mkdtempSync(resolve(tmpdir(), 'portable-header-fictional-')),
    profileId = 'fictional-header';
  const paths = ensureProfileDirectories(root, profileId);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(paths.personal, 'snapshots'), { recursive: true });
  const value = {
    format: 'circus-health-profile-source-v1',
    profileId,
    kind: 'personal',
    revision: 1,
    schemaVersion: 6,
    createdAt: '2026-10-11T00:00:00.000Z',
    semantics: 'fictional-header-regression',
    tables: { notes: [{ id: 'fictional-note', body: 'x'.repeat(1024 * 1024) }] },
  };
  const bytes = Buffer.from(JSON.stringify(value));
  const manifest: PortableManifest = {
    format: 'circus-health-generation-v1',
    profileId,
    kind: 'personal',
    revision: 1,
    file: 'snapshots/fictional.json',
    bytes: bytes.length,
    sha256: hash(bytes),
  };
  writeFileSync(resolve(paths.personal, manifest.file), bytes);
  const originalParse = JSON.parse;
  t.mock.method(JSON, 'parse', (...args: Parameters<typeof JSON.parse>) => {
    if (args[0].length > 64 * 1024) throw Error('fictional whole-row JSON parse');
    return Reflect.apply(originalParse, JSON, args);
  });
  const work = createPortableWorkCounters();
  const headers = withPortableWork(work, () => [
    ...publishedPersonalHeaders(root, profileId, { manifest }),
  ]);
  assert.equal(headers.length, 1);
  assert.equal(headers[0]!.value.revision, 1);
  assert.equal('tables' in headers[0]!.value, false);
  assert.ok(work.maxRowBytes > 1024 * 1024);
  assert.equal(work.maxReadBufferBytes, 64 * 1024);
});
function fixture(t: TestContext, count = 512, extraSourceNames: readonly string[] = []) {
  const root = realpathSync.native(mkdtempSync(resolve(tmpdir(), 'portable-streaming-'))),
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
  for (const [index, name] of extraSourceNames.entries()) {
    const extraPath = paths.relativeRoot + '/sources/' + name;
    const extraBytes = Buffer.from('Fictional original ' + index);
    writeFileSync(resolve(root, extraPath), extraBytes);
    db.prepare('INSERT INTO source_files(id,path,sha256,bytes,details_json) VALUES(?,?,?,?,?)').run(
      'extra-' + index,
      extraPath,
      hash(extraBytes),
      extraBytes.length,
      '{}',
    );
  }
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

test('bounded private projector matches the selected portable logical projection', async (t) => {
  const f = fixture(t, 4, ['a', 'a-🪁', 'a-\uE000']);
  const selected = openPortableRows(f.root, f.profileId);
  let old: ReturnType<typeof projectPortableDatabase>;
  const oldOriginalDigest = createHash('sha256');
  try {
    oldOriginalDigest.update('[');
    let first = true;
    for (const file of selected.originals()) {
      if (!first) oldOriginalDigest.update(',');
      first = false;
      oldOriginalDigest.update(JSON.stringify([file.path, file.sha256, file.bytes]));
    }
    oldOriginalDigest.update(']');
    old = projectPortableDatabase(resolve(f.root, 'old-projection.sqlite'), f.profileId, selected);
  } finally {
    selected.close();
  }
  const pinned = {
    personal: JSON.parse(
      readFileSync(resolve(f.paths.personal, 'current.json'), 'utf8'),
    ) as PortableManifest,
    curation: JSON.parse(
      readFileSync(resolve(f.paths.curation, 'current.json'), 'utf8'),
    ) as PortableManifest,
  };
  const bounded = await projectPortableDatabaseBounded(
    f.root,
    f.profileId,
    resolve(f.root, 'bounded-projection.sqlite'),
    pinned,
    () => {},
  );
  t.after(() => bounded.terminalProof.close());
  if (bounded.logicalSha256 !== old.logicalSha256) {
    const left = new DatabaseSync(old.database, { readOnly: true });
    const right = new DatabaseSync(bounded.database, { readOnly: true });
    try {
      for (const table of Object.keys(old.counts)) {
        const sql = `SELECT * FROM "${table.replaceAll('"', '""')}"`;
        const rows = (db: DatabaseSync) =>
          db
            .prepare(sql)
            .all()
            .map((row) => JSON.stringify(row))
            .sort();
        const expected = rows(left);
        const actual = rows(right);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          const changed = actual.flatMap((row, index) =>
            row === expected[index]
              ? []
              : [
                  {
                    index,
                    actual: row.slice(0, 256),
                    expected: expected[index]?.slice(0, 256),
                  },
                ],
          );
          assert.deepEqual(
            actual.map((row) => hash(row)),
            expected.map((row) => hash(row)),
            `portable table ${table}: ${JSON.stringify(changed.slice(0, 4))}`,
          );
        }
      }
    } finally {
      left.close();
      right.close();
    }
  }
  assert.equal(bounded.logicalSha256, old.logicalSha256);
  assert.equal(bounded.acceptedSourcesSha256, oldOriginalDigest.digest('hex'));
  assert.deepEqual(bounded.counts, old.counts);
  assert.equal(bounded.files, old.files);
  bounded.terminalProof.current();
  const original = resolve(f.root, f.path);
  writeFileSync(original, readFileSync(original));
  assert.throws(() => bounded.terminalProof.current(), /original physical source changed/i);
});

for (const count of [0, 1, 3])
  test(`bounded projector matches synchronous projection with clinical and ${count} personal evidence rows`, async (t) => {
    const f = fixture(t, 0);
    f.db
      .prepare('INSERT INTO documents(id,source_record_id,title) VALUES(?,?,?)')
      .run('fictional-document', 'record-0', 'Fictional retained document');
    const evidence = f.db.prepare(
      'INSERT INTO evidence(id,entity_type,entity_id,source_record_id) VALUES(?,?,?,?)',
    );
    evidence.run('fictional-clinical-evidence', 'document', 'fictional-document', 'record-0');
    for (let i = 0; i < count; i++) {
      const note = createNote(f.db, { kind: 'note', title: `Fictional note ${i}` });
      evidence.run(`fictional-personal-evidence-${i}`, 'note', note.id, 'record-1');
    }
    writePortableSources(f.db, f.root, f.profileId, f.root, { onFile: () => {} });
    const selected = openPortableRows(f.root, f.profileId);
    let synchronous: ReturnType<typeof projectPortableDatabase>;
    try {
      synchronous = projectPortableDatabase(
        resolve(f.root, 'synchronous.sqlite'),
        f.profileId,
        selected,
      );
    } finally {
      selected.close();
    }
    const bounded = await projectPortableDatabaseBounded(
      f.root,
      f.profileId,
      resolve(f.root, 'bounded.sqlite'),
      {
        personal: JSON.parse(
          readFileSync(resolve(f.paths.personal, 'current.json'), 'utf8'),
        ) as PortableManifest,
        curation: JSON.parse(
          readFileSync(resolve(f.paths.curation, 'current.json'), 'utf8'),
        ) as PortableManifest,
      },
      () => {},
    );
    try {
      assert.equal(bounded.counts.evidence, 1 + count);
      assert.deepEqual(bounded.counts, synchronous.counts);
      assert.equal(bounded.logicalSha256, synchronous.logicalSha256);
      bounded.terminalProof.current();
    } finally {
      bounded.terminalProof.close();
    }
  });

test('bounded private projector refuses an original changed after staging', async (t) => {
  const f = fixture(t, 2);
  const pinned = {
    personal: JSON.parse(
      readFileSync(resolve(f.paths.personal, 'current.json'), 'utf8'),
    ) as PortableManifest,
    curation: JSON.parse(
      readFileSync(resolve(f.paths.curation, 'current.json'), 'utf8'),
    ) as PortableManifest,
  };
  const original = resolve(f.root, f.path);
  const sameBytes = readFileSync(original);
  await assert.rejects(
    projectPortableDatabaseBounded(
      f.root,
      f.profileId,
      resolve(f.root, 'tampered-projection.sqlite'),
      pinned,
      () => {},
      {
        phase(phase) {
          if (phase === 'index') writeFileSync(original, sameBytes);
        },
      },
    ),
    /original physical source changed/i,
  );
});

test('bounded private projector refuses target creation and late rewrite from phase callbacks', async (t) => {
  const f = fixture(t, 2);
  const pinned = {
    personal: JSON.parse(
      readFileSync(resolve(f.paths.personal, 'current.json'), 'utf8'),
    ) as PortableManifest,
    curation: JSON.parse(
      readFileSync(resolve(f.paths.curation, 'current.json'), 'utf8'),
    ) as PortableManifest,
  };
  for (const phaseToChange of ['index', 'integrity']) {
    const database = resolve(f.root, `${phaseToChange}-target-rewrite.sqlite`);
    await assert.rejects(
      projectPortableDatabaseBounded(f.root, f.profileId, database, pinned, () => {}, {
        phase(phase) {
          if (phase !== phaseToChange) return;
          if (phase === 'index') writeFileSync(database, 'fictional foreign target');
          else writeFileSync(database, readFileSync(database));
        },
      }),
      phaseToChange === 'index' ? /EEXIST/ : /projection target changed/i,
    );
  }
});

test('bounded private projector will not adopt a target created by a phase callback', async (t) => {
  const f = fixture(t, 2);
  const pinned = {
    personal: JSON.parse(
      readFileSync(resolve(f.paths.personal, 'current.json'), 'utf8'),
    ) as PortableManifest,
    curation: JSON.parse(
      readFileSync(resolve(f.paths.curation, 'current.json'), 'utf8'),
    ) as PortableManifest,
  };
  const database = resolve(f.root, 'phase-created-target.sqlite');
  const foreign = Buffer.from('fictional foreign target');
  await assert.rejects(
    projectPortableDatabaseBounded(f.root, f.profileId, database, pinned, () => {}, {
      phase(phase) {
        if (phase === 'project') writeFileSync(database, foreign);
      },
    }),
    /EEXIST/,
  );
  assert.deepEqual(readFileSync(database), foreign);
});

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

test('streamed generations reach the file in bounded buffers, not one write per piece', (t) => {
  const f = fixture(t),
    output = resolve(f.root, 'export-copy'),
    original = fs.writeSync,
    work = createPortableWorkCounters();
  let writes = 0;
  // Physical file writes, counted at the fs boundary the exporter calls.
  fs.writeSync = ((...args: Parameters<typeof original>) => {
    // Only the generation writer's own output writes, not private spools.
    if (new Error().stack!.includes('writeStreamedGeneration')) writes++;
    return original(...args);
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    withPortableWork(work, () =>
      writePortableSources(f.db, f.root, f.profileId, output, { onFile: () => {} }),
    );
  } finally {
    fs.writeSync = original;
    syncBuiltinESMExports();
  }
  assert.ok(work.outputBytes > 1024 * 1024, 'fixture streams over a MiB of generation output');
  // Two generations, each a run of full buffers plus one final partial flush
  // and its current.json manifest; over 1,500 before buffering.
  assert.ok(
    writes <= Math.ceil(work.outputBytes / DURABLE_OUTPUT_BUFFER_BYTES) + 2 + 2,
    `writes ${writes} for ${work.outputBytes} bytes`,
  );
  assert.ok(work.outputWrites <= writes);
  const selected = openPortableRows(output, f.profileId);
  try {
    assert.deepEqual(
      [...selected.rows('source_records')].map((row) => row.raw_json),
      f.records,
    );
    assert.equal(
      [...selected.rows('app_meta')].filter((row) =>
        String(row.key).startsWith('fictional-retained-'),
      ).length,
      512,
    );
  } finally {
    selected.close();
  }
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

test('cooperative portable export yields to the host and writes the synchronous rows', async (t) => {
  const f = fixture(t, 2048),
    sync = resolve(f.root, 'export-sync'),
    stepwise = resolve(f.root, 'export-stepwise'),
    work: PortableStepWork = { proofs: 0, yields: 0, windows: 0, steps: 0 },
    syncFiles: string[] = [],
    files: string[] = [];
  writePortableSources(f.db, f.root, f.profileId, sync, { onFile: (path) => syncFiles.push(path) });
  let hostTurns = 0,
    checkpoints = 0;
  const host = setInterval(() => hostTurns++, 0);
  try {
    await writePortableSourcesAsync(
      f.db,
      f.root,
      f.profileId,
      stepwise,
      { onFile: (path) => files.push(path) },
      () => checkpoints++,
      { work },
    );
  } finally {
    clearInterval(host);
  }
  // Generation names carry fresh identifiers; everything else is the same.
  const named = (paths: string[]) =>
    paths.map((path) =>
      path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, 'ID'),
    );
  assert.deepEqual(named(files), named(syncFiles));
  assert.ok(files.some((path) => path.endsWith('/curation/current.json')));
  const rows = (output: string) => {
    const selected = openPortableRows(output, f.profileId);
    try {
      return ['source_records', 'source_files', 'app_meta'].map((table) =>
        [...selected.rows(table)].map((row) => JSON.stringify(row)).sort(),
      );
    } finally {
      selected.close();
    }
  };
  assert.deepEqual(rows(stepwise), rows(sync));
  assert.equal(rows(stepwise)[0]!.length, f.records.length);
  assert.ok(work.yields >= 4, `yielded ${work.yields} times`);
  assert.ok(hostTurns > 0, 'host timers ran during the export');
  // The caller's proof opens every window and closes the completed run.
  assert.equal(work.proofs, work.windows + 1);
  assert.equal(checkpoints, work.proofs);
});

test('a cooperative portable export stops at the first failed proof after a yield', async (t) => {
  const f = fixture(t, 2048),
    output = resolve(f.root, 'export-refused'),
    work: PortableStepWork = { proofs: 0, yields: 0, windows: 0, steps: 0 },
    files: string[] = [];
  let changed = false;
  const export_ = writePortableSourcesAsync(
    f.db,
    f.root,
    f.profileId,
    output,
    { onFile: (path) => files.push(path) },
    () => {
      if (changed) throw Error('Fictional source changed');
    },
    { work },
  );
  while (work.yields === 0) await new Promise((done) => setImmediate(done));
  changed = true;
  const yields = work.yields,
    steps = work.steps;
  await assert.rejects(export_, /Fictional source changed/);
  assert.equal(work.yields, yields, 'no window ran after the failed proof');
  assert.equal(work.steps, steps);
  assert.equal(
    files.some((path) => path.endsWith('/curation/current.json')),
    false,
    'the export never reached its final generation',
  );
});
