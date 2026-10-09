import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const root = process.cwd();
const recordPath = root + '/src/server/record-versions.ts';
const testPath = root + '/src/server/test/intake-history-publication.test.ts';
const recordSha = '1433c529eec61e2ab2a2c1680caa1f577da6c42e54ae7e73286d885e5a822913';
const testSha = '1d74f7a6799c8962846a5c34a7384420bf730c6bde021636d659e58dca06feb6';
const variant = process.env.CRS_OWNER_INDEX_VARIANT;
if (!['full', 'partial'].includes(variant)) throw Error('Expected fixed owner-index variant');
const artifactCount = Number(process.env.CRS_OWNER_INDEX_COUNT ?? '32');
if (![4, 32].includes(artifactCount)) throw Error('Expected fictional owner-index count 4 or 32');
if (
  process.env.CRS_HISTORY_WAL_CHECKPOINT_PAGES !== undefined &&
  process.env.CRS_HISTORY_WAL_CHECKPOINT_PAGES !== '32768'
) throw Error('Owner-index A/B requires the production 32768-page WAL threshold');

const sha = (source) => createHash('sha256').update(source).digest('hex');
const replaceOnce = (source, before, after) => {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0)
    throw Error('Owner-index DDL is absent or duplicated');
  return source.slice(0, index) + after + source.slice(index + before.length);
};

const linkFull = "CREATE INDEX IF NOT EXISTS __record_link_owner ON __record_versions(profile_id,entity,json_extract(contents_json,'$.note_id'),sequence DESC);";
const attachmentFull = "CREATE INDEX IF NOT EXISTS __record_attachment_owner ON __record_versions(profile_id,entity,json_extract(contents_json,'$.owner_type'),json_extract(contents_json,'$.owner_id'),sequence DESC);";
export const transformRecord = (source) => {
  if (variant === 'full') return source;
  source = replaceOnce(source, linkFull,
    "CREATE INDEX IF NOT EXISTS __record_link_owner ON __record_versions(profile_id,entity,json_extract(contents_json,'$.note_id'),sequence DESC) WHERE json_extract(contents_json,'$.note_id') IS NOT NULL;");
  return replaceOnce(source, attachmentFull,
    "CREATE INDEX IF NOT EXISTS __record_attachment_owner ON __record_versions(profile_id,entity,json_extract(contents_json,'$.owner_type'),json_extract(contents_json,'$.owner_id'),sequence DESC) WHERE json_extract(contents_json,'$.owner_type') IS NOT NULL AND json_extract(contents_json,'$.owner_id') IS NOT NULL;");
};

const extraTest = String.raw`
if (process.env.CRS_OWNER_INDEX_DIAGNOSTIC === '1')
  test('owner index matched publication: ' + Number(process.env.CRS_OWNER_INDEX_COUNT ?? '32') + ' artifacts', async (t) => {
    const count = Number(process.env.CRS_OWNER_INDEX_COUNT ?? '32');
    const f = await publicationFixture(t, count);
    const databasePath = profilePaths(f.root, f.profileId).database;
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    let indexCells;
    let btreeTotals;
    try {
      const rows = reader.prepare("SELECT name,sum(ncell) AS cells,count(*) AS pages,sum(pgsize) AS bytes FROM dbstat WHERE name IN ('__record_link_owner','__record_attachment_owner') GROUP BY name").all();
      indexCells = Object.fromEntries(rows.map((row) => [String(row.name), {
        cells: Number(row.cells), pages: Number(row.pages), bytes: Number(row.bytes),
      }]));
      const total = reader.prepare('SELECT count(*) AS pages,sum(pgsize) AS bytes FROM dbstat').get();
      const allIndexes = reader.prepare("SELECT count(*) AS pages,sum(pgsize) AS bytes FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE type='index')").get();
      btreeTotals = {
        all: { pages: Number(total.pages), bytes: Number(total.bytes) },
        indexes: { pages: Number(allIndexes.pages), bytes: Number(allIndexes.bytes) },
      };
    } finally {
      reader.close();
    }
    for (const name of ['__record_link_owner','__record_attachment_owner'])
      assert.ok(indexCells[name]?.pages > 0, 'both derived owner indexes must exist');
    const row = f.db.prepare("SELECT count(*) AS total,sum(CASE WHEN entity='app_meta' THEN 1 ELSE 0 END) AS metadata,sum(CASE WHEN json_extract(contents_json,'$.note_id') IS NOT NULL THEN 1 ELSE 0 END) AS linkEligible,sum(CASE WHEN json_extract(contents_json,'$.owner_type') IS NOT NULL AND json_extract(contents_json,'$.owner_id') IS NOT NULL THEN 1 ELSE 0 END) AS attachmentEligible FROM __record_versions").get();
    assert.ok(row);
    const versions = {
      total: Number(row.total), metadata: Number(row.metadata),
      linkEligible: Number(row.linkEligible), attachmentEligible: Number(row.attachmentEligible),
    };
    assert.ok(versions.total > 0 && versions.metadata > 0);
    assert.ok(versions.metadata <= versions.total);
    const expectedLinkCells = process.env.CRS_OWNER_INDEX_VARIANT === 'partial'
      ? versions.linkEligible : versions.total;
    const expectedAttachmentCells = process.env.CRS_OWNER_INDEX_VARIANT === 'partial'
      ? versions.attachmentEligible : versions.total;
    assert.equal(indexCells.__record_link_owner.cells, expectedLinkCells);
    assert.equal(indexCells.__record_attachment_owner.cells, expectedAttachmentCells);
    const indexSql = f.db.prepare("SELECT name,sql FROM sqlite_master WHERE name IN ('__record_link_owner','__record_attachment_owner') ORDER BY name").all();
    assert.equal(indexSql.length, 2);
    for (const index of indexSql)
      assert.equal(String(index.sql).includes(' WHERE '), process.env.CRS_OWNER_INDEX_VARIANT === 'partial');
    const projection = f.db.prepare('SELECT projection,sequence,head_json FROM __record_state WHERE singleton=1').get();
    assert.ok(projection && Number(projection.sequence) > 0 && String(projection.head_json).length > 0);
    const rows = {
      current: Number(f.db.prepare('SELECT count(*) AS count FROM __record_current').get().count),
      fields: Number(f.db.prepare('SELECT count(*) AS count FROM __record_fields').get().count),
      transactions: Number(f.db.prepare('SELECT count(*) AS count FROM __record_transactions').get().count),
      sourceVersion: intakeSourceVersion(f.db, f.original.id).version,
    };
    assert.ok(rows.current > 0 && rows.transactions > 0 && rows.sourceVersion > 0);
    assert.ok(btreeTotals.all.pages >= btreeTotals.indexes.pages);
    t.diagnostic(JSON.stringify({ ownerIndexDiagnostic: {
      variant: process.env.CRS_OWNER_INDEX_VARIANT,
      sourceHead: '0d88ab3fa12059945550da7c7439b8d532a6b950',
      artifacts: count, versions, indexCells, btreeTotals, rows,
      projection: Number(projection.projection),
      note: 'Fixture publication assertions and original authority guards ran unchanged. dbstat cells count B-tree entries; total B-tree pages exclude freelist and are not main-file length or physical writes. Full/partial legs use fresh disposable caches; random fixture identities can alter tree shape. Publication probe above includes setup drain and final WAL drain, journal bytes, CPU and process fsWrite. No production index migration or policy is implied.',
    } }));
  });
`;

export const transformTest = (source) => source + extraTest;
for (const [path, expected] of [[recordPath, recordSha], [testPath, testSha]]) {
  if (sha(readFileSync(path, 'utf8')) !== expected) throw Error('Pinned owner-index source changed');
}
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
