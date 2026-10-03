import test from 'node:test';
import { sourceFiles } from '../queries.ts';
import {
  sourceDetailsSearchCounters,
  clearSourceDetailsSearchCache,
} from '../source-details-search.ts';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { attachRecordDurability, type RecordStorage } from '../record-versions.ts';
import {
  sourceTextProjectionCounters,
  clearSourceTextProjectionCache,
} from '../source-text-projection.ts';

test('100/200/300 actual source-list requests and mutations separately measure logical SQL writes, allocation and authority', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fictional-rope-growth-')),
    profileId = 'fictional-rope-growth';
  const db = openDatabase(join(root, 'cache.sqlite'), profileId),
    objects = new Map<string, Buffer>();
  let authorityWrites = 0,
    authorityWrittenBytes = 0;
  const emptyReads = () => ({
    head: { calls: 0, missing: 0, returnedBytes: 0, copiedBytes: 0 },
    immutable: { calls: 0, missing: 0, returnedBytes: 0, copiedBytes: 0 },
  });
  const authorityReads = emptyReads(),
    requestOnlyAuthorityReads = emptyReads();
  const readDifference = (after: typeof authorityReads, before: typeof authorityReads) => {
    const result = emptyReads();
    for (const kind of ['head', 'immutable'] as const)
      for (const key of ['calls', 'missing', 'returnedBytes', 'copiedBytes'] as const)
        result[kind][key] = after[kind][key] - before[kind][key];
    return result;
  };
  const storage: RecordStorage = {
    read(name) {
      const counters = authorityReads[name === 'head' ? 'head' : 'immutable'];
      counters.calls++;
      const retained = objects.get(name);
      if (!retained) {
        counters.missing++;
        return null;
      }
      const returned = Buffer.from(retained);
      counters.returnedBytes += returned.length;
      counters.copiedBytes += returned.length;
      return returned;
    },
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
    clearSourceDetailsSearchCache(db);
    clearSourceTextProjectionCache(db);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  let text = 'Fictional beginning. ' + 'ab'.repeat(5000) + ' Fictional ending Ω 😀.';
  const raw = () => '{ "fictionalText": ' + JSON.stringify(text) + ', "literalEscape": "\\ud800" }';
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run('changing', 'fictional.txt', 'a'.repeat(64), 0, 'derived', raw());
  attachRecordDurability(db, { profileId, storage });
  const request = () => {
    const params = new URLSearchParams({ q: 'Fictional beginning', limit: '1' });
    const oracle = db
      .prepare(
        'SELECT id,details_json FROM source_files WHERE path LIKE ? OR details_json LIKE ? ORDER BY path LIMIT 1',
      )
      .all('%Fictional beginning%', '%Fictional beginning%');
    const count = Number(
      db
        .prepare('SELECT count(*) n FROM source_files WHERE path LIKE ? OR details_json LIKE ?')
        .get('%Fictional beginning%', '%Fictional beginning%')!.n,
    );
    // Only the application request belongs here: SQL oracle work above and
    // transaction durability work outside this call have separate attribution.
    const beforeRequest = structuredClone(authorityReads);
    const actual = (() => {
      try {
        return sourceFiles(db, params);
      } finally {
        const delta = readDifference(authorityReads, beforeRequest);
        for (const kind of ['head', 'immutable'] as const)
          for (const key of ['calls', 'missing', 'returnedBytes', 'copiedBytes'] as const)
            requestOnlyAuthorityReads[kind][key] += delta[kind][key];
      }
    })();
    assert.equal(actual.total, count);
    assert.deepEqual(
      actual.data.map((row) => ({ id: row.id, details: row.details })),
      oracle.map((row) => ({ id: row.id, details: JSON.parse(String(row.details_json)) })),
    );
    assert.equal(sourceDetailsSearchCounters(db).activeRequests, 0);
  };
  request();
  const initial = structuredClone(sourceTextProjectionCounters(db));
  const baselineAuthority = { writes: authorityWrites, bytes: authorityWrittenBytes };
  const initialAuthorityReads = structuredClone(authorityReads);
  const initialRequestOnlyAuthorityReads = structuredClone(requestOnlyAuthorityReads);
  db.exec('CREATE TEMP TABLE rope_write_audit(kind TEXT,payload TEXT)');
  const fields = {
    contents: ['id', 'text'],
    occurrences: ['source_id', 'id', 'content_id', 'start', 'end'],
    links: ['source_id', 'id', 'next'],
    heads: [
      'source_id',
      'profile_id',
      'source_hash',
      'details_digest',
      'head_json',
      'authority_key',
      'authority_head',
    ],
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
    queryCounters: structuredClone(sourceDetailsSearchCounters(db)),
    durableStorageReads: {
      cumulative: structuredClone(authorityReads),
      sinceInitial: readDifference(authorityReads, initialAuthorityReads),
      requestOnlyCumulative: structuredClone(requestOnlyAuthorityReads),
      requestOnlySinceInitial: readDifference(
        requestOnlyAuthorityReads,
        initialRequestOnlyAuthorityReads,
      ),
    },
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
      request();
    });
    const after = structuredClone(sourceTextProjectionCounters(db));
    assert.equal(after.authorityReads - before.authorityReads, 1);
    assert.equal(after.reconciledSources - before.reconciledSources, 1);
    assert.equal(after.rebuiltSources, initial.rebuiltSources);
    assert.ok(after.projectionWrites - before.projectionWrites <= 8);
    assert.ok(after.projectionBytes - before.projectionBytes < 4096);
    assert.ok(after.cleanupAffectedReferences - before.cleanupAffectedReferences <= 2);
    request();
    const warm = structuredClone(sourceTextProjectionCounters(db));
    request();
    assert.equal(sourceTextProjectionCounters(db).authorityReads, warm.authorityReads);
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
        'Independently fictional repeated one-character prefix insertion fixture only; SQL audit totals actual row writes and JSON payload bytes. Page allocation includes the accepted index and source rows. Accepted source versions and changed-source full-view reads grow; engine/matching counters include linear prior reads, hashing and logical copies. Durable-storage counters count actual read calls, missing returns, returned bytes and Buffer.from copied bytes separately for heads and immutable objects; request-only deltas bracket sourceFiles and exclude oracle and outer transaction publication. These fixture counters do not count decryption, physical disk IO or implementation-internal copies. This does not establish changed-only CPU or arbitrary mutation capacity.',
    }),
  );
});
