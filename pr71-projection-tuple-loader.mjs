import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const head = '0d88ab3fa12059945550da7c7439b8d532a6b950';
const root = process.cwd();
const recordPath = root + '/src/server/record-versions.ts';
const testPath = root + '/src/server/test/intake-history-publication.test.ts';
const recordSha = '1433c529eec61e2ab2a2c1680caa1f577da6c42e54ae7e73286d885e5a822913';
const testSha = '1d74f7a6799c8962846a5c34a7384420bf730c6bde021636d659e58dca06feb6';
const variant = process.env.CRS_PROJECTION_TUPLE_VARIANT;
const count = Number(process.env.CRS_PROJECTION_TUPLE_COUNT ?? '32');
if (process.env.CRS_PROJECTION_TUPLE_DIAGNOSTIC !== '1')
  throw Error('Projection tuple requires its explicit diagnostic gate');
if (!['object', 'tuple'].includes(variant)) throw Error('Expected fixed projection tuple variant');
if (![4, 32].includes(count)) throw Error('Expected fictional artifact count 4 or 32');
if (
  process.env.CRS_HISTORY_WAL_CHECKPOINT_PAGES !== undefined &&
  process.env.CRS_HISTORY_WAL_CHECKPOINT_PAGES !== '32768'
) throw Error('Projection tuple requires the production 32768-page WAL threshold');

const sha = (source) => createHash('sha256').update(source).digest('hex');
const replaceOnce = (source, before, after) => {
  const at = source.indexOf(before);
  if (at < 0 || source.indexOf(before, at + before.length) >= 0)
    throw Error('Projection tuple transform anchor absent or duplicated');
  return source.slice(0, at) + after + source.slice(at + before.length);
};
if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== head)
  throw Error('Pinned source HEAD changed');
for (const [path, expected] of [[recordPath, recordSha], [testPath, testSha]])
  if (sha(readFileSync(path, 'utf8')) !== expected) throw Error('Pinned source changed');

const codec = String.raw`
const diagnosticMetadataKeys = [
  'actor','deleted','entity','format','operationId','origin','previousVersion',
  'profileId','recordId','recordedAt','references','schemaVersion','sequence','versionId',
] as const;
const diagnosticMetadataKeyset = [...diagnosticMetadataKeys].sort().join(',');
export function diagnosticMetadataTuple(metadata: Record<string, unknown>): unknown[] {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) ||
      Object.keys(metadata).sort().join(',') !== diagnosticMetadataKeyset)
    fail('invalid projection tuple metadata keys');
  const tuple = diagnosticMetadataKeys.map((key) => metadata[key]);
  if (tuple.some((value) => value === undefined)) fail('missing projection tuple metadata value');
  return tuple;
}
export function diagnosticMetadataObject(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== diagnosticMetadataKeys.length ||
      !diagnosticMetadataKeys.every((_, index) =>
        Object.hasOwn(value, index) && value[index] !== undefined))
    fail('invalid projection tuple metadata shape');
  return Object.fromEntries(diagnosticMetadataKeys.map((key, index) => [key, value[index]]));
}
`;

export const transformRecord = (source) => {
  if (variant === 'object') return source;
  source = replaceOnce(source, 'function indexTransaction(', codec + '\nfunction indexTransaction(');
  source = replaceOnce(source, 'stringifyRecordJson(metadata),', 'stringifyRecordJson(diagnosticMetadataTuple(metadata)),');
  return replaceOnce(
    source,
    'parseRecordJson(String(row.metadata_json)) as Omit<',
    'diagnosticMetadataObject(parseRecordJson(String(row.metadata_json))) as Omit<',
  );
};

const extraTest = String.raw`
if (process.env.CRS_PROJECTION_TUPLE_DIAGNOSTIC === '1')
  test('projection tuple matched publication: ' + process.env.CRS_PROJECTION_TUPLE_VARIANT + ' ' + Number(process.env.CRS_PROJECTION_TUPLE_COUNT ?? '32') + ' artifacts', async (t) => {
    const variant = process.env.CRS_PROJECTION_TUPLE_VARIANT;
    const count = Number(process.env.CRS_PROJECTION_TUPLE_COUNT ?? '32');
    assert.ok(variant === 'object' || variant === 'tuple');
    assert.ok(count === 4 || count === 32);
    const record = await import('../record-versions.ts');
    const literal = {
      actor: { kind: 'system', id: 'fictional-actor' }, deleted: false,
      entity: 'app_meta', format: 'health-record-versions-v1',
      operationId: 'fictional-operation', origin: { kind: 'fixture' },
      previousVersion: null, profileId: 'fictional-profile',
      recordId: '["fictional-key"]', recordedAt: '2026-01-01T00:00:00Z',
      references: [{ kind: 'fictional-reference' }], schemaVersion: 1,
      sequence: 1, versionId: 'fictional-version',
    };
    if (variant === 'tuple') {
      const tuple = record.diagnosticMetadataTuple(literal);
      assert.equal(tuple.length, 14);
      assert.deepEqual(record.diagnosticMetadataObject(JSON.parse(JSON.stringify(tuple))), literal);
      const sparse = [...tuple];
      delete sparse[3];
      for (const malformed of [null, {}, [], tuple.slice(1), [...tuple, null], sparse])
        assert.throws(() => record.diagnosticMetadataObject(malformed));
      for (const malformed of [
        Object.fromEntries(Object.entries(literal).filter(([key]) => key !== 'actor')),
        { ...literal, unexpected: 'fictional' },
        { ...literal, actor: undefined },
      ]) assert.throws(() => record.diagnosticMetadataTuple(malformed));
    } else assert.deepEqual(JSON.parse(JSON.stringify(literal)), literal);

    const f = await publicationFixture(t, count);
    const databasePath = profilePaths(f.root, f.profileId).database;
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    let metrics, selected;
    try {
      const aggregate = reader.prepare(
        "SELECT count(*) AS versions,sum(length(CAST(metadata_json AS BLOB))) AS metadataUtf8,sum(length(CAST(contents_json AS BLOB))) AS contentsUtf8 FROM __record_versions",
      ).get();
      const footprint = reader.prepare(
        "SELECT pagetype,count(*) AS pages,sum(pgsize) AS bytes,sum(payload) AS payloadBytes,sum(unused) AS unusedBytes FROM dbstat WHERE name='__record_versions' GROUP BY pagetype ORDER BY pagetype",
      ).all();
      const kind = reader.prepare(
        "SELECT count(*) AS arrayRows FROM __record_versions WHERE json_type(metadata_json)='array'",
      ).get();
      metrics = {
        versions: Number(aggregate.versions), metadataUtf8: Number(aggregate.metadataUtf8),
        contentsUtf8: Number(aggregate.contentsUtf8), arrayRows: Number(kind.arrayRows),
        btree: Object.fromEntries(footprint.map((row) => [String(row.pagetype), {
          pages: Number(row.pages), bytes: Number(row.bytes),
          payloadBytes: Number(row.payloadBytes), unusedBytes: Number(row.unusedBytes),
        }])),
        current: Number(reader.prepare('SELECT count(*) AS rows FROM __record_current').get().rows),
        fields: Number(reader.prepare('SELECT count(*) AS rows FROM __record_fields').get().rows),
        transactions: Number(reader.prepare('SELECT count(*) AS rows FROM __record_transactions').get().rows),
        sourceVersion: intakeSourceVersion(f.db, f.original.id).version,
      };
      selected = reader.prepare(
        "SELECT profile_id,entity,record_id,version_id,sequence,contents_json,metadata_json FROM __record_versions WHERE entity='app_meta' AND previous_version IS NULL AND deleted=0 AND json_type(contents_json,'$.key')='text' AND json_extract(contents_json,'$.key') GLOB 'intake_state_v1:*:node:*' ORDER BY sequence DESC LIMIT 1",
      ).get();
    } finally {
      reader.close();
    }
    assert.ok(selected);
    assert.ok(Object.values(metrics).filter((value) => typeof value === 'number')
      .every((value) => Number.isSafeInteger(value) && value >= 0));
    assert.ok(metrics.versions > 0 && metrics.current > 0 && metrics.transactions > 0);
    assert.equal(metrics.arrayRows, variant === 'tuple' ? metrics.versions : 0);
    for (const [type, value] of Object.entries(metrics.btree)) {
      assert.ok(['internal','leaf','overflow'].includes(type));
      assert.ok(Object.values(value).every((number) => Number.isSafeInteger(number) && number >= 0));
      assert.ok(value.payloadBytes + value.unusedBytes <= value.bytes);
    }
    assert.ok(metrics.btree.leaf?.pages > 0);
    assert.equal(fileBytes(databasePath + '-wal'), 0, 'fixture final WAL drain must remain complete');

    const args = [f.db, String(selected.profile_id), String(selected.entity),
      String(selected.record_id), String(selected.version_id)];
    const version = record.readIndexedRecordVersion(...args);
    assert.ok(version);
    const { openContributorRecordStorage } = await import('../contributor-record-storage.ts');
    const { databaseSchemaVersion } = await import('../database.ts');
    const storage = openContributorRecordStorage(f.root, f.profileId, { readOnly: true });
    let accepted, acceptedRows = 0;
    try {
      const checked = (ref) => {
        const bytes = storage.read(String(ref.name));
        assert.ok(Buffer.isBuffer(bytes));
        assert.equal(bytes.length, Number(ref.bytes));
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), String(ref.sha256));
        return bytes;
      };
      const headRef = JSON.parse(storage.read('head').toString('utf8'));
      const commit = JSON.parse(checked(headRef).toString('utf8'));
      record.verifyRecordAuthorityHead(storage, f.profileId, databaseSchemaVersion(f.db));
      assert.equal(commit.profileId, f.profileId);
      assert.equal(commit.schemaVersion, databaseSchemaVersion(f.db));
      let pending = Buffer.alloc(0);
      for (const ref of record.iterateRecordCommitSegments(storage, commit)) {
        pending = Buffer.concat([pending, checked(ref)]);
        for (let end = pending.indexOf(10); end >= 0; end = pending.indexOf(10)) {
          const line = pending.subarray(0, end);
          pending = pending.subarray(end + 1);
          const value = JSON.parse(line.toString('utf8'));
          if (value.versionId === selected.version_id) {
            assert.equal(accepted, undefined, 'selected accepted version must occur once');
            accepted = value;
          }
          acceptedRows++;
        }
      }
      assert.equal(pending.length, 0);
      assert.equal(acceptedRows, commit.records);
    } finally {
      storage.close();
    }
    assert.ok(accepted, 'selected latest version must be in accepted head commit');
    assert.deepEqual(version, accepted);
    const encoded = JSON.parse(String(selected.metadata_json));
    const expected = variant === 'tuple' ? record.diagnosticMetadataObject(encoded) : encoded;
    assert.deepEqual(version, { ...expected, contents: JSON.parse(String(selected.contents_json)) });
    const key = JSON.parse(String(selected.record_id));
    assert.ok(Array.isArray(key) && key.length === 1 && typeof key[0] === 'string');
    const page = record.queryRecordHistory(f.db, {
      profileId: f.profileId, entity: 'app_meta', recordId: key[0], field: 'value', limit: 1,
    });
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].versionId, version.versionId);
    assert.deepEqual(page.entries[0].contents, version.contents);
    assert.deepEqual(page.entries[0].changes.map((change) => change.field), ['key', 'value']);
    const { changes, ...selectedHistoryVersion } = page.entries[0];
    assert.deepEqual(selectedHistoryVersion, accepted);

    const mutate = (sql, params) => {
      f.db.exec('BEGIN IMMEDIATE');
      try {
        f.db.prepare(sql).run(...params);
        assert.throws(() => record.readIndexedRecordVersion(...args));
      } finally {
        f.db.exec('ROLLBACK');
      }
      assert.deepEqual(record.readIndexedRecordVersion(...args), version);
    };
    const wrongShape = variant === 'tuple'
      ? JSON.stringify(encoded.slice(1))
      : JSON.stringify({ ...encoded, unexpected: 'fictional' });
    mutate('UPDATE __record_versions SET metadata_json=? WHERE version_id=?',
      [wrongShape, selected.version_id]);
    const drift = (key, value) => {
      const next = variant === 'tuple' ? [...encoded] : { ...encoded };
      if (variant === 'tuple') {
        const keys = ['actor','deleted','entity','format','operationId','origin','previousVersion',
          'profileId','recordId','recordedAt','references','schemaVersion','sequence','versionId'];
        next[keys.indexOf(key)] = value;
      } else next[key] = value;
      mutate('UPDATE __record_versions SET metadata_json=? WHERE version_id=?',
        [JSON.stringify(next), selected.version_id]);
    };
    drift('profileId', 'wrong-fictional-profile');
    drift('schemaVersion', 0);
    drift('deleted', 'false');
    mutate('UPDATE __record_versions SET sequence=sequence+1 WHERE version_id=?',
      [selected.version_id]);

    t.diagnostic(JSON.stringify({ projectionTupleDiagnostic: {
      variant, sourceHead: '${head}', artifacts: count, metrics,
      selectedHistory: { acceptedHeadVersion: true, exactVersion: true,
        valueFieldPage: true, corruptionsRefused: 5 },
      note: 'All original fictional publication guards and final WAL drain ran before read-only metrics. Codec stores all fourteen independent metadata values; selected read reconstructs the object before unchanged indexedVersion validation. Postprobe rollback-only corruption controls are excluded from publication work counters. Fresh random IDs change tree shape across legs; equal contracts/counts do not establish identical raw bytes. dbstat page occupancy and Linux process fsWrite are not device writes or authority. This is a disposable format efficacy trial, not a supported projection migration.',
    } }));
  });
`;

export const transformTest = (source) => source + extraTest;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url.endsWith('/record-versions.ts')) {
      const source = String(loaded.source);
      if (sha(source) !== recordSha) throw Error('Loaded record-version source changed');
      return { ...loaded, source: transformRecord(source) };
    }
    if (url.endsWith('/intake-history-publication.test.ts')) {
      const source = String(loaded.source);
      if (sha(source) !== testSha) throw Error('Loaded history test source changed');
      return { ...loaded, source: transformTest(source) };
    }
    return loaded;
  },
});
