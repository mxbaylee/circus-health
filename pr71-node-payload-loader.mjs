import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const sourceHead = '8b1652ef567a4447851a94d1a204c5e846f4eade';
const testPath = process.cwd() + '/src/server/test/intake-history-publication.test.ts';
const recordPath = process.cwd() + '/src/server/record-versions.ts';
const treePath = process.cwd() + '/src/server/intake-state-tree.ts';
const testSha = '1d74f7a6799c8962846a5c34a7384420bf730c6bde021636d659e58dca06feb6';
const recordSha = '1433c529eec61e2ab2a2c1680caa1f577da6c42e54ae7e73286d885e5a822913';
const treeSha = 'e55786071356f5834fcbb7e99a9997cf9ecdad1035c257e0201b22f0b0a275e2';
const count = Number(process.env.CRS_NODE_PAYLOAD_COUNT ?? '32');
if (process.env.CRS_NODE_PAYLOAD_DIAGNOSTIC !== '1')
  throw Error('Node payload decomposition requires its explicit diagnostic gate');
if (![4, 32].includes(count)) throw Error('Expected fictional node payload count 4 or 32');
if (
  process.env.CRS_HISTORY_WAL_CHECKPOINT_PAGES !== undefined &&
  process.env.CRS_HISTORY_WAL_CHECKPOINT_PAGES !== '32768'
) throw Error('Node payload decomposition requires the production 32768-page WAL threshold');

const sha = (source) => createHash('sha256').update(source).digest('hex');
if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== sourceHead)
  throw Error('Pinned source HEAD changed');
for (const [path, expected] of [[testPath, testSha], [recordPath, recordSha], [treePath, treeSha]])
  if (sha(readFileSync(path, 'utf8')) !== expected) throw Error('Pinned source file changed');

const extraTest = String.raw`
if (process.env.CRS_NODE_PAYLOAD_DIAGNOSTIC === '1')
  test('committed node payload decomposition: ' + Number(process.env.CRS_NODE_PAYLOAD_COUNT ?? '32') + ' artifacts', { timeout: 300_000 }, async (t) => {
    const count = Number(process.env.CRS_NODE_PAYLOAD_COUNT ?? '32');
    assert.ok(count === 4 || count === 32);
    const f = await publicationFixture(t, count);
    const databasePath = profilePaths(f.root, f.profileId).database;
    const reader = new DatabaseSync(databasePath, { readOnly: true });
    const numeric = () => ({
      rows: 0, contentsUtf8: 0, metadataUtf8: 0, rawNodeUtf8: 0,
      formatUtf8: 0, identityUtf8: 0, keyUtf8: 0, valueUtf8: 0,
      leftRefUtf8: 0, rightRefUtf8: 0, syntaxUtf8: 0,
    });
    const totals = { all: numeric(), leaf: numeric(), internal: numeric() };
    const uniqueNodeHashes = new Map();
    const exactIdentityKeyValues = new Map();
    const valueOnly = new Map();
    const byteLength = (value) => Buffer.byteLength(value, 'utf8');
    const add = (target, value) => {
      for (const name of Object.keys(target)) target[name] += value[name];
    };
    const remember = (groups, key, bytes) => {
      const prior = groups.get(key);
      if (prior) {
        assert.equal(prior.bytes, bytes);
        prior.nodes++;
      } else groups.set(key, { nodes: 1, bytes });
    };
    const repeated = (groups) => {
      const result = { groups: 0, distinctNodesInGroups: 0, repeatedValueUtf8: 0, largestGroup: 0 };
      for (const group of groups.values()) {
        result.largestGroup = Math.max(result.largestGroup, group.nodes);
        if (group.nodes < 2) continue;
        result.groups++;
        result.distinctNodesInGroups += group.nodes;
        result.repeatedValueUtf8 += (group.nodes - 1) * group.bytes;
      }
      return result;
    };
    let currentNodeRows;
    try {
      const rows = reader.prepare(
        "SELECT record_id,contents_json,metadata_json FROM __record_versions WHERE entity='app_meta' AND json_type(contents_json,'$.key')='text' AND json_extract(contents_json,'$.key') GLOB 'intake_state_v1:*:node:*'",
      );
      for (const row of rows.iterate()) {
        assert.equal(typeof row.contents_json, 'string');
        assert.equal(typeof row.metadata_json, 'string');
        let contents;
        try { contents = JSON.parse(row.contents_json); }
        catch { throw Error('Invalid fictional version contents'); }
        if (typeof contents.key !== 'string' || typeof contents.value !== 'string' ||
            JSON.stringify([contents.key]) !== row.record_id)
          throw Error('Invalid fictional node version binding');
        const raw = contents.value;
        let node;
        try { node = JSON.parse(raw); }
        catch { throw Error('Invalid fictional raw node'); }
        if (node.format !== 'health-intake-node-v4' ||
            JSON.stringify(Object.keys(node)) !== JSON.stringify(['format','identity','key','value','left','right']) ||
            typeof node.key !== 'string' || typeof node.value !== 'string' ||
            JSON.stringify(node) !== raw)
          throw Error('Invalid fictional canonical node');
        const marker = ':node:';
        const at = contents.key.lastIndexOf(marker);
        assert.ok(at > 0 && at + marker.length + 64 === contents.key.length);
        const nodeHash = contents.key.slice(at + marker.length);
        if (!/^[a-f0-9]{64}$/.test(nodeHash) ||
            crypto.createHash('sha256').update(raw).digest('hex') !== nodeHash)
          throw Error('Invalid fictional node digest');

        const metrics = numeric();
        metrics.rows = 1;
        metrics.contentsUtf8 = byteLength(row.contents_json);
        metrics.metadataUtf8 = byteLength(row.metadata_json);
        metrics.rawNodeUtf8 = byteLength(raw);
        metrics.formatUtf8 = byteLength(JSON.stringify(node.format));
        metrics.identityUtf8 = byteLength(JSON.stringify(node.identity));
        metrics.keyUtf8 = byteLength(JSON.stringify(node.key));
        metrics.valueUtf8 = byteLength(JSON.stringify(node.value));
        metrics.leftRefUtf8 = byteLength(JSON.stringify(node.left));
        metrics.rightRefUtf8 = byteLength(JSON.stringify(node.right));
        metrics.syntaxUtf8 = metrics.rawNodeUtf8 - metrics.formatUtf8 - metrics.identityUtf8 -
          metrics.keyUtf8 - metrics.valueUtf8 - metrics.leftRefUtf8 - metrics.rightRefUtf8;
        assert.ok(metrics.syntaxUtf8 >= 0);
        add(totals.all, metrics);
        add(node.left === null && node.right === null ? totals.leaf : totals.internal, metrics);
        const priorRaw = uniqueNodeHashes.get(nodeHash);
        if (priorRaw !== undefined) {
          if (priorRaw !== raw) throw Error('Inconsistent fictional node digest');
          continue;
        }
        uniqueNodeHashes.set(nodeHash, raw);
        remember(exactIdentityKeyValues, JSON.stringify([node.identity,node.key,node.value]), metrics.valueUtf8);
        remember(valueOnly, node.value, metrics.valueUtf8);
      }
      currentNodeRows = Number(reader.prepare(
        "SELECT count(*) AS rows FROM app_meta WHERE key GLOB 'intake_state_v1:*:node:*'",
      ).get().rows);
    } finally {
      reader.close();
    }
    assert.ok(totals.all.rows > 0);
    assert.equal(totals.all.rows, totals.leaf.rows + totals.internal.rows);
    for (const metric of Object.keys(totals.all))
      assert.equal(totals.all[metric], totals.leaf[metric] + totals.internal[metric]);
    for (const group of Object.values(totals))
      assert.ok(Object.values(group).every((value) => Number.isSafeInteger(value) && value >= 0));
    assert.ok(Number.isSafeInteger(currentNodeRows) && currentNodeRows > 0 && currentNodeRows <= totals.all.rows);
    const uniqueHashes = uniqueNodeHashes.size;
    assert.ok(uniqueHashes > 0 && uniqueHashes <= totals.all.rows);
    const exactRepeat = repeated(exactIdentityKeyValues);
    const valueRepeat = repeated(valueOnly);
    assert.ok(exactRepeat.distinctNodesInGroups <= uniqueHashes);
    assert.ok(valueRepeat.distinctNodesInGroups <= uniqueHashes);
    assert.ok(exactRepeat.repeatedValueUtf8 <= valueRepeat.repeatedValueUtf8);
    assert.equal(fileBytes(databasePath + '-wal'), 0, 'fixture final WAL drain must remain complete');
    t.diagnostic(JSON.stringify({ nodePayloadDiagnostic: {
      artifacts: count, storedNodeVersions: totals.all.rows, uniqueNodeHashes: uniqueHashes,
      currentNodeRows, totals, exactRepeat, valueRepeat,
      note: 'Fictional fixture only, after unchanged publication assertions and final WAL drain; publicationFixture finishes its publication probe before this scan. All aggregates count stored historical node versions, not selected-root reachable nodes. Exact repeat groups require identical identity, key and value across distinct node hashes; value-only groups are an intentionally looser upper bound. The diagnostic holds exact fictional grouping keys and raw nodes in memory only until completion and logs no row values, IDs or node hashes. JSON component lengths partition rawNodeUtf8 but are nested in contentsUtf8; they are not additive storage savings. left/right null encodings and fixed object syntax are counted. Read-only grouping work is outside publication fs/CPU counters and may add host I/O. Repetition is not proof that accepted history bytes can be removed, nor is it physical I/O or a production memory bound. Random fixture identifiers can change AVL topology.',
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
    if (url.endsWith('/intake-state-tree.ts') && sha(String(loaded.source)) !== treeSha)
      throw Error('Loaded tree source changed');
    return loaded;
  },
});
