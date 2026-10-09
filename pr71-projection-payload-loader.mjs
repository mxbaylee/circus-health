import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const sourceHead = '0d88ab3fa12059945550da7c7439b8d532a6b950';
const testPath = process.cwd() + '/src/server/test/intake-history-publication.test.ts';
const recordPath = process.cwd() + '/src/server/record-versions.ts';
const testSha = '1d74f7a6799c8962846a5c34a7384420bf730c6bde021636d659e58dca06feb6';
const recordSha = '1433c529eec61e2ab2a2c1680caa1f577da6c42e54ae7e73286d885e5a822913';
const count = Number(process.env.CRS_PROJECTION_PAYLOAD_COUNT ?? '32');
if (process.env.CRS_PROJECTION_PAYLOAD_DIAGNOSTIC !== '1')
  throw Error('Payload decomposition requires its explicit diagnostic gate');
if (![4, 32].includes(count)) throw Error('Expected fictional payload count 4 or 32');
if (
  process.env.CRS_HISTORY_WAL_CHECKPOINT_PAGES !== undefined &&
  process.env.CRS_HISTORY_WAL_CHECKPOINT_PAGES !== '32768'
) throw Error('Payload decomposition requires the production 32768-page WAL threshold');

const sha = (source) => createHash('sha256').update(source).digest('hex');
if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sourceHead)
  throw Error('Pinned source HEAD changed');
if (sha(readFileSync(testPath, 'utf8')) !== testSha)
  throw Error('Pinned history test source changed');
if (sha(readFileSync(recordPath, 'utf8')) !== recordSha)
  throw Error('Pinned record-version source changed');

const extraTest = String.raw`
if (process.env.CRS_PROJECTION_PAYLOAD_DIAGNOSTIC === '1')
  test('record projection payload decomposition: ' + Number(process.env.CRS_PROJECTION_PAYLOAD_COUNT ?? '32') + ' artifacts', async (t) => {
    const count = Number(process.env.CRS_PROJECTION_PAYLOAD_COUNT ?? '32');
    assert.ok(count === 4 || count === 32);
    const f = await publicationFixture(t, count);
    const databasePath = profilePaths(f.root, f.profileId).database;
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    let versionClasses, currentNodes, btrees, filePages, totalVersions;
    try {
      totalVersions = Number(reader.prepare('SELECT count(*) AS rows FROM __record_versions').get().rows);
      const classes = reader.prepare(
        "SELECT CASE WHEN entity='app_meta' AND json_type(contents_json,'$.key')='text' AND json_extract(contents_json,'$.key') GLOB 'intake_state_v1:*:node:*' THEN 'historicalNodeMeta' WHEN entity='app_meta' THEN 'otherHistoricalMeta' ELSE 'otherHistoricalEntity' END AS class, count(*) AS rows, sum(length(CAST(contents_json AS BLOB))) AS contentsUtf8, sum(length(CAST(metadata_json AS BLOB))) AS metadataUtf8, sum(CASE WHEN entity='app_meta' AND json_type(contents_json,'$.key')='text' AND json_extract(contents_json,'$.key') GLOB 'intake_state_v1:*:node:*' AND json_type(contents_json,'$.value')='text' THEN length(CAST(json_extract(contents_json,'$.value') AS BLOB)) ELSE 0 END) AS nodeValueUtf8, sum(length(CAST(version_id AS BLOB))+length(CAST(profile_id AS BLOB))+length(CAST(entity AS BLOB))+length(CAST(record_id AS BLOB))+length(CAST(recorded_at AS BLOB))+coalesce(length(CAST(previous_version AS BLOB)),0)+length(CAST(operation_id AS BLOB))) AS scalarTextUtf8 FROM __record_versions GROUP BY class",
      ).all();
      versionClasses = Object.fromEntries(classes.map((row) => [String(row.class), {
        rows: Number(row.rows),
        contentsUtf8: Number(row.contentsUtf8),
        metadataUtf8: Number(row.metadataUtf8),
        nodeValueUtf8: Number(row.nodeValueUtf8),
        scalarTextUtf8: Number(row.scalarTextUtf8),
      }]));
      const current = reader.prepare(
        "SELECT count(*) AS rows,coalesce(sum(length(CAST(value AS BLOB))),0) AS valueUtf8 FROM app_meta WHERE key GLOB 'intake_state_v1:*:node:*'",
      ).get();
      currentNodes = { rows: Number(current.rows), valueUtf8: Number(current.valueUtf8) };
      const pages = reader.prepare(
        "SELECT name,pagetype,count(*) AS pages,sum(pgsize) AS bytes,sum(payload) AS payloadBytes,sum(unused) AS unusedBytes,sum(ncell) AS cells FROM dbstat WHERE name IN ('__record_versions','app_meta') GROUP BY name,pagetype ORDER BY name,pagetype",
      ).all();
      btrees = Object.fromEntries(['__record_versions','app_meta'].map((name) => [name, {}]));
      for (const page of pages) {
        const name = String(page.name), type = String(page.pagetype);
        assert.ok(name === '__record_versions' || name === 'app_meta');
        assert.ok(['internal','leaf','overflow'].includes(type));
        assert.equal(btrees[name][type], undefined);
        btrees[name][type] = {
          pages: Number(page.pages), bytes: Number(page.bytes),
          payloadBytes: Number(page.payloadBytes), unusedBytes: Number(page.unusedBytes),
          cells: Number(page.cells),
        };
      }
      filePages = {
        pageCount: Number(reader.prepare('PRAGMA page_count').get().page_count),
        freelistCount: Number(reader.prepare('PRAGMA freelist_count').get().freelist_count),
      };
    } finally {
      reader.close();
    }
    assert.equal(Object.values(versionClasses).reduce((sum, row) => sum + row.rows, 0), totalVersions);
    assert.ok(Number.isSafeInteger(totalVersions) && totalVersions > 0);
    for (const row of Object.values(versionClasses))
      assert.ok(Object.values(row).every((value) => Number.isSafeInteger(value) && value >= 0));
    assert.ok(versionClasses.historicalNodeMeta?.rows > 0);
    assert.ok(versionClasses.historicalNodeMeta.nodeValueUtf8 > 0);
    assert.ok(Object.values(currentNodes).every((value) => Number.isSafeInteger(value) && value >= 0));
    assert.ok(currentNodes.rows > 0 && currentNodes.rows <= versionClasses.historicalNodeMeta.rows);
    for (const name of ['__record_versions','app_meta']) {
      assert.ok(Object.values(btrees[name]).reduce((sum, row) => sum + row.pages, 0) > 0);
      for (const row of Object.values(btrees[name])) {
        assert.ok(Object.values(row).every((value) => Number.isSafeInteger(value) && value >= 0));
        assert.ok(row.payloadBytes + row.unusedBytes <= row.bytes);
      }
    }
    assert.ok(Object.values(filePages).every((value) => Number.isSafeInteger(value) && value >= 0));
    assert.ok(filePages.pageCount > 0);
    assert.equal(fileBytes(databasePath + '-wal'), 0, 'fixture final WAL drain must remain complete');
    t.diagnostic(JSON.stringify({ projectionPayloadDiagnostic: {
      sourceHead: '${sourceHead}', artifacts: count, totalVersions,
      versionClasses, currentNodes, btrees, filePages,
      note: 'Fictional fixture only. publicationFixture performed its unchanged full publication assertions, setup drain, and final drain before this read-only postpublication query. HistoricalNodeMeta identifies fixed key shape, not a recovered tree/reachable-node count; currentNodes counts node-shaped rows stored in app_meta, not selected-root reachable nodes. nodeValueUtf8 decodes JSON text before measuring UTF-8 and is nested within contentsUtf8, not an additive byte component. scalarTextUtf8 excludes SQLite integer/record overhead and is not removable space. dbstat scans named B-trees and reports page payload/unused, not physical writes or whole-file bytes; overflow page cells may be zero. No row keys, raw values, SQL contents, or private health data are emitted. Random fixture identities can alter tree shape.',
    } }));
  });
`;

export const transformTest = (source) => source + extraTest;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url.endsWith('/intake-history-publication.test.ts')) {
      const source = String(loaded.source);
      if (sha(source) !== testSha) throw Error('Loaded history test source changed');
      return { ...loaded, source: transformTest(source) };
    }
    if (url.endsWith('/record-versions.ts') && sha(String(loaded.source)) !== recordSha)
      throw Error('Loaded record-version source changed');
    return loaded;
  },
});
