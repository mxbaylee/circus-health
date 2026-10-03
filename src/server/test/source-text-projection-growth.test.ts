import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { attachRecordDurability, type RecordStorage } from '../record-versions.ts';
import {
  readSourceTextProjection,
  reconcileSourceTextProjection,
  sourceTextProjectionCounters,
} from '../source-text-projection.ts';

test('100/200/300 actual automatic updates separately measure logical SQL writes, allocation and authority', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-rope-growth-')),
    profileId = 'fictional-rope-growth';
  const db = openDatabase(join(root, 'cache.sqlite'), profileId),
    objects = new Map<string, Buffer>();
  let authorityWrites = 0,
    authorityWrittenBytes = 0;
  const storage: RecordStorage = {
    read: (name) => (objects.has(name) ? Buffer.from(objects.get(name)!) : null),
    writeImmutable(name, value) {
      assert.equal(objects.has(name), false);
      objects.set(name, Buffer.from(value));
      authorityWrites++;
      authorityWrittenBytes += value.length;
    },
    publishHead(value) {
      objects.set('head', Buffer.from(value));
      authorityWrites++;
      authorityWrittenBytes += value.length;
    },
  };
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  let text = 'Fictional beginning. ' + 'ab'.repeat(5000) + ' Fictional ending Ω 😀.';
  const raw = () => '{ "fictionalText": ' + JSON.stringify(text) + ', "literalEscape": "\\ud800" }';
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run('changing', 'fictional.txt', 'a'.repeat(64), 0, 'derived', raw());
  attachRecordDurability(db, { profileId, storage });
  assert.equal(readSourceTextProjection(db, 'changing'), raw());
  const initial = structuredClone(sourceTextProjectionCounters(db));
  const baselineAuthority = { writes: authorityWrites, bytes: authorityWrittenBytes };
  db.exec('CREATE TEMP TABLE rope_write_audit(kind TEXT,payload TEXT)');
  const fields = {
    contents: ['id', 'text'],
    occurrences: ['source_id', 'id', 'content_id', 'start', 'end'],
    links: ['source_id', 'id', 'next'],
    heads: ['source_id', 'profile_id', 'source_hash', 'details_digest', 'head_json'],
  };
  const independentlyMeasuredInitialRows = Object.entries(fields).map(([name, columns]) => {
    const sqlColumns = columns
      .map((column) => {
        const [key, sql = key] = column.split(':');
        return `"${sql}" AS "${key}"`;
      })
      .join(',');
    const rows = db.prepare(`SELECT ${sqlColumns} FROM __record_source_text_${name}`).all();
    return {
      kind: name,
      rows: rows.length,
      encodedBytes: rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0),
    };
  });
  for (const [name, columns] of Object.entries(fields)) {
    const args = columns
      .map((column) => {
        const [key, sql = key] = column.split(':');
        return `'${key}',NEW."${sql}"`;
      })
      .join(',');
    for (const event of ['INSERT', 'UPDATE'])
      db.exec(
        `CREATE TEMP TRIGGER audit_${name}_${event} AFTER ${event} ON main.__record_source_text_${name} BEGIN INSERT INTO rope_write_audit VALUES('${name}',json_object(${args})); END`,
      );
  }
  const measure = () => ({
    counters: structuredClone(sourceTextProjectionCounters(db)),
    independentlyObservedWrites: db
      .prepare(
        'SELECT kind,count(*) rows,sum(length(CAST(payload AS BLOB))) bytes,max(length(CAST(payload AS BLOB))) maximumRowBytes FROM rope_write_audit GROUP BY kind ORDER BY kind',
      )
      .all(),
    allocatedBytes:
      Number(db.prepare('PRAGMA page_count').get()!.page_count) *
      Number(db.prepare('PRAGMA page_size').get()!.page_size),
    acceptedAuthority: {
      writes: authorityWrites - baselineAuthority.writes,
      writtenBytes: authorityWrittenBytes - baselineAuthority.bytes,
      retainedBytes: [...objects.values()].reduce((sum, value) => sum + value.length, 0),
      objects: objects.size,
    },
  });
  const baseline = {
      ...measure(),
      initialAuthorityPublication: baselineAuthority,
      independentlyMeasuredInitialRows,
      sourceTextUtf8Bytes: Buffer.byteLength(raw()),
      sourceTextUtf16Units: raw().length,
    },
    samples = [];
  for (let step = 1; step <= 300; step++) {
    text = 'x' + text;
    const expected = raw(),
      before = structuredClone(sourceTextProjectionCounters(db));
    transaction(db, () => {
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(expected, 'changing');
      reconcileSourceTextProjection(db);
    });
    const after = structuredClone(sourceTextProjectionCounters(db));
    assert.equal(after.authorityReads - before.authorityReads, 1);
    assert.equal(after.reconciledSources - before.reconciledSources, 1);
    assert.equal(after.rebuiltSources, initial.rebuiltSources);
    assert.ok(after.projectionWrites - before.projectionWrites <= 8);
    assert.ok(after.projectionBytes - before.projectionBytes < 4096);
    assert.ok(after.cleanupAffectedReferences - before.cleanupAffectedReferences <= 2);
    assert.equal(readSourceTextProjection(db, 'changing'), expected);
    assert.deepEqual(Buffer.from(readSourceTextProjection(db, 'changing')), Buffer.from(expected));
    const warm = structuredClone(sourceTextProjectionCounters(db));
    reconcileSourceTextProjection(db);
    assert.deepEqual(sourceTextProjectionCounters(db), warm);
    if (step % 100 === 0) samples.push({ updates: step, ...measure() });
  }
  const final = measure();
  for (const row of final.independentlyObservedWrites) {
    const key = (
      { contents: 'content', occurrences: 'occurrence', links: 'link', heads: 'head' } as const
    )[row.kind as keyof typeof fields];
    const counters = final.counters;
    assert.equal(Number(row.rows), counters[`${key}RowsWritten`] - initial[`${key}RowsWritten`]);
    assert.equal(Number(row.bytes), counters[`${key}BytesWritten`] - initial[`${key}BytesWritten`]);
    assert.ok(Number(row.maximumRowBytes) <= (key === 'content' ? 8192 : 2048));
  }
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM __record_versions WHERE entity GLOB '__record_source_text_*'",
      )
      .get()!.n,
    0,
  );
  t.diagnostic(
    JSON.stringify({
      baseline,
      samples,
      limitation:
        'Independently fictional repeated one-character prefix insertion fixture only; SQL audit totals actual row writes and JSON payload bytes. Page allocation includes the accepted index and source rows. Accepted source versions and changed-source full-view reads grow; engine/matching counters include linear prior reads, hashing and logical copies. This does not establish changed-only CPU or arbitrary mutation capacity.',
    }),
  );
});
