import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const head = '8b1652ef567a4447851a94d1a204c5e846f4eade';
const files = new Map([
  ['intake-state-tree.ts', 'e55786071356f5834fcbb7e99a9997cf9ecdad1035c257e0201b22f0b0a275e2'],
  ['intake-state-graph.ts', '7f205641f90466500fa410ef281d235129a18e663b9f927ccca90869a1a55342'],
  ['record-versions.ts', '1433c529eec61e2ab2a2c1680caa1f577da6c42e54ae7e73286d885e5a822913'],
  ['intake-history-publication.test.ts', '1d74f7a6799c8962846a5c34a7384420bf730c6bde021636d659e58dca06feb6'],
]);
const variant = process.env.CRS_NODE_CODEC_MODE;
const count = Number(process.env.CRS_NODE_CODEC_COUNT ?? '32');
if (process.env.CRS_NODE_CODEC_DIAGNOSTIC !== '1' ||
    !['plain', 'compressed'].includes(variant) || ![4, 32].includes(count))
  throw Error('Explicit node codec variant and 4/32 fixture count required');
if (process.env.CRS_HISTORY_WAL_CHECKPOINT_PAGES !== '32768')
  throw Error('Node codec comparison requires unchanged 32768-page WAL policy');
if (execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== head)
  throw Error('Pinned source HEAD changed');
const sha = (source) => createHash('sha256').update(source).digest('hex');
for (const [name, expected] of files) {
  const path = process.cwd() + '/src/server/' + (name.endsWith('.test.ts') ? 'test/' : '') + name;
  if (sha(readFileSync(path, 'utf8')) !== expected) throw Error('Pinned source file changed: ' + name);
}

const codec = String.raw`
// Diagnostic-only encoding. Stored bytes, not decoded bytes, bind the node hash.
import { deflateRawSync, inflateRawSync } from 'node:zlib';
const codecCounters = { deflateCalls: 0, inflateCalls: 0, originalBytes: 0,
  storedBytes: 0, compressedNodes: 0, rawNodes: 0, deflateCpuMicros: 0,
  inflateCpuMicros: 0 };
(globalThis as any).__pr71NodeCodecCounters = codecCounters;
const codecMarker = '~z1:';
function decodedIntakeTreeRaw(stored: unknown): unknown {
  if (typeof stored !== 'string' || !stored.startsWith(codecMarker)) return stored;
  if (Buffer.byteLength(stored) > INTAKE_TREE_PAGE_BYTES) invalid('encoded collection page bytes');
  const base64 = stored.slice(codecMarker.length);
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) invalid('compressed node base64');
  const compressed = Buffer.from(base64, 'base64');
  if (compressed.toString('base64') !== base64) invalid('noncanonical compressed node');
  const before = process.cpuUsage();
  let decoded: ReturnType<typeof inflateRawSync>;
  try {
    const result = inflateRawSync(compressed, { maxOutputLength: INTAKE_TREE_PAGE_BYTES, info: true });
    if (result.engine.bytesWritten !== compressed.length) invalid('trailing compressed node bytes');
    decoded = result.buffer;
  } catch { invalid('compressed node'); }
  const elapsed = process.cpuUsage(before);
  codecCounters.inflateCalls++;
  codecCounters.inflateCpuMicros += elapsed.user + elapsed.system;
  const raw = decoded!.toString('utf8');
  if (!Buffer.from(raw, 'utf8').equals(decoded!)) invalid('compressed node UTF-8');
  return raw;
}
function encodedIntakeTreeRaw(raw: string): string {
  codecCounters.originalBytes += Buffer.byteLength(raw);
  if (process.env.CRS_NODE_CODEC_MODE !== 'compressed') {
    codecCounters.storedBytes += Buffer.byteLength(raw);
    codecCounters.rawNodes++;
    return raw;
  }
  const before = process.cpuUsage();
  const compressed = deflateRawSync(Buffer.from(raw, 'utf8'), { level: 1 });
  const elapsed = process.cpuUsage(before);
  codecCounters.deflateCalls++;
  codecCounters.deflateCpuMicros += elapsed.user + elapsed.system;
  const stored = codecMarker + compressed.toString('base64');
  if (Buffer.byteLength(stored) >= Buffer.byteLength(raw)) {
    codecCounters.storedBytes += Buffer.byteLength(raw);
    codecCounters.rawNodes++;
    return raw;
  }
  codecCounters.storedBytes += Buffer.byteLength(stored);
  codecCounters.compressedNodes++;
  return stored;
}
`;
function once(source, needle, replacement) {
  if (source.split(needle).length !== 2) throw Error('Transform anchor not unique: ' + needle.slice(0, 50));
  return source.replace(needle, replacement);
}
function transformTree(source) {
  let next = once(source, 'export const INTAKE_TREE_PAGE_BYTES', codec + '\nexport const INTAKE_TREE_PAGE_BYTES');
  next = once(next, 'const node = decode(raw, INTAKE_TREE_PAGE_BYTES);',
    'const node = decode(decodedIntakeTreeRaw(raw), INTAKE_TREE_PAGE_BYTES);');
  next = once(next,
    'const raw = JSON.stringify(node);\n    if (Buffer.byteLength(raw) > INTAKE_TREE_PAGE_BYTES) invalid(\'collection page bytes\');',
    'const canonical = JSON.stringify(node);\n    if (Buffer.byteLength(canonical) > INTAKE_TREE_PAGE_BYTES) invalid(\'collection page bytes\');\n    const raw = encodedIntakeTreeRaw(canonical);');
  next = once(next, 'preparedBytes += Buffer.byteLength(raw);', 'preparedBytes += Buffer.byteLength(canonical);');
  next = once(next, "recordIntakeWork('collectionPreparedBytes', Buffer.byteLength(raw));",
    "recordIntakeWork('collectionPreparedBytes', Buffer.byteLength(canonical));");
  return next;
}

const appendedTest = String.raw`
if (process.env.CRS_NODE_CODEC_DIAGNOSTIC === '1')
  test('bounded node codec comparison: ' + Number(process.env.CRS_NODE_CODEC_COUNT ?? '32') + ' artifacts',
    { timeout: 300_000 }, async (t) => {
      const count = Number(process.env.CRS_NODE_CODEC_COUNT ?? '32');
      const variant = process.env.CRS_NODE_CODEC_MODE;
      assert.ok(count === 4 || count === 32);
      assert.ok(variant === 'plain' || variant === 'compressed');
      const { deflateRawSync } = await import('node:zlib');
      const { decodeIntakeTreeNode, createIntakeTree } = await import('../intake-state-tree.ts');
      const identity = { profileId: 'fictional-profile', intakeId: 'fictional-intake', sourceHash: 'f'.repeat(64) };
      const node = { format: 'health-intake-node-v4', identity, key: 'k',
        value: 'fictional '.repeat(100), left: null, right: null };
      const canonical = JSON.stringify(node);
      const compressed = '~z1:' + deflateRawSync(Buffer.from(canonical), { level: 1 }).toString('base64');
      const ref = (stored: string) => ({ hash: crypto.createHash('sha256').update(stored).digest('hex'),
        count: 1, height: 1, first: 'k', last: 'k' });
      assert.deepEqual(decodeIntakeTreeNode(canonical, ref(canonical), identity), node);
      assert.deepEqual(decodeIntakeTreeNode(compressed, ref(compressed), identity), node);
      const mixedParent = { ...node, key: 'z', value: 'parent', left: ref(canonical) };
      const mixedRaw = '~z1:' + deflateRawSync(Buffer.from(JSON.stringify(mixedParent)), { level: 1 }).toString('base64');
      const mixedRef = { hash: crypto.createHash('sha256').update(mixedRaw).digest('hex'),
        count: 2, height: 2, first: 'k', last: 'z' };
      const mixedRows = new Map([[mixedRef.hash, mixedRaw], [ref(canonical).hash, canonical]]);
      const mixedTree = createIntakeTree(identity, (hash: string) => mixedRows.get(hash), new Map());
      assert.equal(mixedTree.get(mixedRef, 'k'), node.value);
      assert.equal(mixedTree.get(mixedRef, 'z'), 'parent');
      const corrupt = [
        '~z1:%%%%', '~z1:A',
        '~z1:' + Buffer.from(compressed.slice(4), 'base64').subarray(0, -1).toString('base64'),
        '~z1:' + Buffer.concat([Buffer.from(compressed.slice(4), 'base64'), Buffer.from([1])]).toString('base64'),
        '~z1:' + deflateRawSync(Buffer.from('x'.repeat(32 * 1024 + 1))).toString('base64'),
        '~z1:' + 'A'.repeat(32 * 1024),
        '~z1:' + deflateRawSync(Buffer.from([0xff])).toString('base64'),
        '~z1:' + deflateRawSync(Buffer.from('{}')).toString('base64'),
      ];
      for (const stored of corrupt)
        assert.throws(() => decodeIntakeTreeNode(stored, ref(stored), identity));
      assert.throws(() => decodeIntakeTreeNode(compressed, ref(canonical), identity));
      const initialCodecWork = { ...(globalThis as any).__pr71NodeCodecCounters };
      const f = await publicationFixture(t, count);
      const afterFixtureCodecWork = { ...(globalThis as any).__pr71NodeCodecCounters };
      const { openIntakeCollectionEnvelope, iterateIntakeEnvelopeText } = await import('../intake-collection-envelope.ts');
      const view = openIntakeCollectionEnvelope(f.db, { id: f.original.id });
      const text = [...view.recordChunks(view.root())].join('');
      assert.equal([...iterateIntakeEnvelopeText(f.db, { id: f.original.id })].join(''), text);
      const selected = JSON.parse(text);
      assert.equal(typeof text, 'string');
      const selectedSource = f.db.prepare('SELECT id,kind,sha256 FROM source_files WHERE id=?').get(f.original.id)!;
      assert.equal(selectedSource.id, f.original.id);
      assert.equal(selectedSource.kind, 'intake_original');
      assert.match(String(selectedSource.sha256), /^[a-f0-9]{64}$/);
      assert.equal(selected.intake.originalName, 'fictional.txt');
      assert.equal(selected.intake.version, intakeSourceVersion(f.db, f.original.id).version);
      assert.equal(selected.intake.proposals.length, count + 1);
      const expected = Array.from({ length: count }, (_, n) => 'proposal:fictional-artifact-' + n);
      assert.deepEqual(selected.intake.proposals.slice(1).map((x: any) => x.id), expected);
      const candidate = selected.intake.workflow.candidates.find((x: any) =>
        x.versions?.some((v: any) => v.occurrences?.some((o: any) => expected.includes(o.proposalId))));
      assert.ok(candidate);
      const oldRecord = envelope('fictional-history');
      oldRecord.payload = { literal: '11.00' };
      oldRecord.clinical = { ...(oldRecord.clinical as Record<string, unknown>), valueText: '11.00' };
      const latestRecord = structuredClone(oldRecord);
      latestRecord.payload = { literal: '12.00' };
      latestRecord.clinical = { ...(latestRecord.clinical as Record<string, unknown>), valueText: '12.00' };
      const source = f.db.prepare('SELECT id,sha256 FROM source_files WHERE id=?').get(f.original.id)!;
      assert.equal(candidate.id, intakeCandidateId({ id: String(source.id), sha256: String(source.sha256) }, { value: oldRecord }));
      assert.equal(candidate.versions.length, 2);
      assert.equal(candidate.versions[0].id, intakeCandidateVersionIdForRevision({ value: oldRecord }));
      assert.equal(candidate.versions[1].id, intakeCandidateVersionIdForRevision({ value: latestRecord }));
      assert.equal(candidate.versions[0].contentDigest, workflowHash(canonicalLiteral(oldRecord)));
      assert.equal(candidate.versions[1].contentDigest, workflowHash(canonicalLiteral(latestRecord)));
      assert.equal(candidate.versions[0].occurrences.length, count * 2 - 1);
      assert.equal(candidate.versions[1].occurrences.length, 1);
      assert.equal(candidate.versions[1].occurrences[0].proposalId, expected.at(-1));
      assert.deepEqual(candidate.versions[0].occurrences.map((x: any) => x.proposalId),
        [...expected.slice(0, -1), ...Array(count).fill(expected[0])]);
      const group = selected.intake.workflow.reportGroups.find((x: any) => x.id === f.groupId);
      assert.ok(group);
      const members = group.versions.at(-1).members;
      assert.equal(members[0].candidateId, candidate.id);
      assert.equal(members[1].candidateId, candidate.id);
      assert.equal(members[0].occurrences.length, count * 2 - 1);
      assert.equal(members[1].occurrences.length, 1);
      const reader = new DatabaseSync(profilePaths(f.root, f.profileId).database, { readOnly: true });
      let historicalNodes = 0, compressedNodes = 0, rawNodes = 0, historicalStoredBytes = 0;
      try {
        for (const row of reader.prepare("SELECT contents_json FROM __record_versions WHERE entity='app_meta' AND json_type(contents_json,'$.key')='text' AND json_extract(contents_json,'$.key') GLOB 'intake_state_v1:*:node:*'").iterate()) {
          const value = JSON.parse(String(row.contents_json)).value;
          assert.equal(typeof value, 'string');
          historicalNodes++;
          historicalStoredBytes += Buffer.byteLength(value);
          if (value.startsWith('~z1:')) compressedNodes++;
          else { assert.ok(value.startsWith('{')); rawNodes++; }
        }
      } finally { reader.close(); }
      assert.ok(historicalNodes > 0);
      assert.equal(historicalNodes, compressedNodes + rawNodes);
      if (variant === 'plain') assert.equal(compressedNodes, 0);
      else assert.ok(compressedNodes > 0);
      assert.equal(fileBytes(profilePaths(f.root, f.profileId).database + '-wal'), 0);
      const counters = (globalThis as any).__pr71NodeCodecCounters;
      assert.ok(counters);
      const difference = (after: any, before: any) => Object.fromEntries(Object.entries(after).map(([key, value]) =>
        [key, Number(value) - Number(before[key])]));
      const fixtureCodecWork = difference(afterFixtureCodecWork, initialCodecWork);
      const selectedReadCodecWork = difference(counters, afterFixtureCodecWork);
      for (const work of [fixtureCodecWork, selectedReadCodecWork])
        assert.ok(Object.values(work).every((value) => Number.isSafeInteger(value) && value >= 0));
      assert.ok(fixtureCodecWork.originalBytes >= fixtureCodecWork.storedBytes);
      t.diagnostic(JSON.stringify({ nodeCodecDiagnostic: { variant, artifacts: count,
        historicalNodes, compressedNodes, rawNodes, historicalStoredBytes,
        fixtureCodecWork, selectedReadCodecWork,
        note: 'Fictional matched-work legs use fresh random IDs; bounded selected-envelope fields and membership are independently checked within each leg. Fixture codec work includes setup plus publication, not only maintenance; selectedReadCodecWork includes root recordChunks, complete native stream comparison, and discovery. publicationFixture freezes publication/CPU/fs counters and drains WAL before these reads and the historical scan. Codec CPU includes per-call observer overhead, not isolated production cost. Historical stored bytes are not selected-root reachability or physical writes; graph copy can emit raw v4 in a compressed leg. Whole-publication process fsWrite including final drain is the primary A/B metric.'
      } }));
    });
`;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    for (const [name, expected] of files)
      if (url.endsWith('/' + name) && sha(String(loaded.source)) !== expected)
        throw Error('Loaded source changed: ' + name);
    if (url.endsWith('/intake-state-tree.ts'))
      return { ...loaded, source: transformTree(String(loaded.source)) };
    if (url.endsWith('/intake-history-publication.test.ts'))
      return { ...loaded, source: String(loaded.source) + appendedTest };
    return loaded;
  },
});
