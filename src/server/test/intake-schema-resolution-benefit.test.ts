import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, transaction } from '../database.ts';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { memoryRecordAuthority } from './helpers/intake-authority-fixture.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { collectionCellReader, createSchemaEnvelopeReader } from '../intake-collection-envelope.ts';
import { parseSchemaControl, schemaOrdinal } from '../intake-envelope-schema.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';

async function fixture(t: test.TestContext, extras = 0) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-schema-resolve-authority-'));
  const path = join(root, 'current.sqlite');
  const identity = {
    profileId: 'fictional-schema-memo',
    intakeId: 'fictional-original',
    sourceHash: 'c'.repeat(64),
  };
  const db = openDatabase(path, identity.profileId);
  const authority = memoryRecordAuthority(db);
  const initial = prepareInitialIntakeEnvelope(
    '{"intake":{"version":0,"scope":{"subject":{"value":"old"},"subject":{"value":"new"}},"records":' +
      JSON.stringify(Array.from({ length: extras }, (_, id) => ({ id }))) +
      '}}',
  );
  transaction(db, () => {
    db.prepare(
      'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
    ).run(
      identity.intakeId,
      'fictional.json',
      identity.sourceHash,
      0,
      'intake_original',
      initial.detailsJson,
    );
    createIntakeStateStorage(db, identity).stage(initial.state, randomUUID());
  });
  t.after(() => {
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = { id: identity.intakeId, kind: 'intake_original', sha256: identity.sourceHash };
  await buildIntakeCollectionEnvelope(db, source);
  const selected = collectionCellReader(db, source);
  const control = parseSchemaControl(
    selected.collections.get(
      selected.collections.openView(),
      'logical',
      'envelope.control',
      'representation',
    ),
  );
  const reader = createSchemaEnvelopeReader(selected.store, control, selected.head.logical);
  const nest = reader.child(reader.child(reader.root(), 'intake')!, 'scope')!;
  const record = reader.child(nest, 'subject')!;
  const id = reader.address(record);
  const read = () => reader.resolve(id).kind;
  const expected = read();
  const descriptor = selected.collections.collection(
    selected.collections.openView(),
    'logical',
    'envelope.data',
  )!;
  const prefix = intakeNamespace(identity) + 'node:';
  function nodeFor(cell: string) {
    let ref = descriptor.root;
    while (ref) {
      const key = prefix + ref.hash;
      const raw = String(db.prepare('SELECT value FROM main.app_meta WHERE key=?').get(key)!.value);
      const node = JSON.parse(raw);
      if (node.key === cell) return { key, raw, cell };
      ref = cell < node.key ? node.left : node.right;
    }
    throw Error('Missing selected schema cell ' + cell);
  }
  const cells = ['r:' + id];
  let cursor = id;
  while (cursor !== control.root) {
    cells.push('p:' + cursor);
    const edge = JSON.parse(String(selected.store.get('p:' + cursor)));
    cells.push(
      edge.field === null
        ? 'o:' + edge.parent + ':' + schemaOrdinal(edge.ordinal)
        : 'f:' + edge.parent + ':' + edge.field,
    );
    cursor = edge.parent;
  }
  assert.ok(cells.length >= 7);
  return {
    db,
    path,
    source,
    authority,
    selected,
    control,
    reader,
    nest,
    id,
    read,
    expected,
    nodes: cells.map(nodeFor),
  };
}

test('actual retained schema resolved reads preserve complete bytes with measured work', async (t) => {
  const f = await fixture(t, 8);
  const expectedText = Array.from(f.reader.recordChunks(f.reader.root())).join('');
  const intake = f.reader.child(f.reader.root(), 'intake')!;
  const ids = [
    f.id,
    ...Array.from({ length: 8 }, (_, n) =>
      f.reader.address(f.reader.childAt(intake, 'records', n)!),
    ),
  ];
  const expected = ids.map((id) => f.reader.resolve(id).kind);
  // All selected headers are cold/hot real authenticated schema cells, never mocks.
  for (let n = 0; n < ids.length; n++) assert.equal(f.reader.resolve(ids[n]!).kind, expected[n]);
  let heads = 0;
  const read = f.authority.storage.read;
  f.authority.storage.read = function (name) {
    if (name === 'head') heads++;
    return read(name);
  };
  const before = structuredClone(intakeWorkCounters(f.db).warm);
  const primitiveBefore = { ...intakeWorkCounters(f.db).primitive };
  const start = performance.now();
  for (let pass = 0; pass < 32; pass++)
    for (let n = 0; n < ids.length; n++) {
      const previousHeads = heads;
      assert.equal(f.reader.resolve(ids[n]!).kind, expected[n]);
      assert.ok(heads > previousHeads, 'every resolved call still checks physical accepted HEAD');
    }
  const elapsedMs = performance.now() - start;
  const after = structuredClone(intakeWorkCounters(f.db).warm);
  const primitiveAfter = { ...intakeWorkCounters(f.db).primitive };
  const measuredHeads = heads;
  assert.equal(Array.from(f.reader.recordChunks(f.reader.root())).join(''), expectedText);
  clearIntakeStateCache(f.db);
  assert.equal(
    Array.from(f.reader.recordChunks(f.reader.root())).join(''),
    expectedText,
    'cache disposal preserves complete selected lexical bytes',
  );
  const visits =
    after.collectionNodeReads -
    before.collectionNodeReads +
    after.collectionNodeCacheHits -
    before.collectionNodeCacheHits;
  const items = after.collectionItemsRead - before.collectionItemsRead;
  if (Object.hasOwn(f.selected.collections, 'resolveSchemaRecord'))
    assert.equal(
      items,
      0,
      'complete warm header/ancestry reuse skips only already authenticated point values',
    );
  t.diagnostic(
    JSON.stringify({
      fixture: 'actual accepted schema',
      outputsSha256: createHash('sha256')
        .update(JSON.stringify({ expectedText, expected, passes: 32 }))
        .digest('hex'),
      resolvedCalls: 32 * ids.length,
      items,
      visits,
      rawNodes: after.collectionNodeReads - before.collectionNodeReads,
      rawBytes: after.collectionReadBytes - before.collectionReadBytes,
      witnessQueries: after.collectionReadWitnessQueries - before.collectionReadWitnessQueries,
      metadataReads: primitiveAfter.metadataReads - primitiveBefore.metadataReads,
      metadataBytes: primitiveAfter.metadataReadBytes - primitiveBefore.metadataReadBytes,
      heads: measuredHeads,
      elapsedMs,
    }),
  );
});

test('resolved schema memo respects aggregate encoded bytes below the entry limit', async (t) => {
  const f = await fixture(t, 30);
  const intake = f.reader.child(f.reader.root(), 'intake')!;
  const ids = Array.from({ length: 30 }, (_, n) =>
    f.reader.address(f.reader.childAt(intake, 'records', n)!),
  );
  const view = f.selected.collections.openView();
  const binding = f.selected.collections.binding(view)!;
  const changes = ids.map((id, n) => ({
    area: 'logical' as const,
    collection: 'envelope.data',
    op: 'put' as const,
    key: 'r:' + id,
    value: JSON.stringify({
      ...JSON.parse(String(f.selected.store.get('r:' + id))),
      kind: 'q'.repeat(7900) + n,
    }),
  }));
  // Forward-compatible kind strings remain genuine accepted bounded headers.
  const operationId = randomUUID();
  const prepared = f.selected.collections.prepare(view, {
    operationId,
    requestDigest: createHash('sha256').update(operationId).digest('hex'),
    domainVersion: binding.logical.domainVersion + 1,
    changes,
  });
  transaction(f.db, () => f.selected.collections.stage(prepared));
  const selected = collectionCellReader(f.db, f.source);
  const control = parseSchemaControl(
    selected.collections.get(
      selected.collections.openView(),
      'logical',
      'envelope.control',
      'representation',
    ),
  );
  const reader = createSchemaEnvelopeReader(selected.store, control, selected.head.logical);
  const read = f.authority.storage.read;
  let headCalls = 0;
  f.authority.storage.read = (name) => {
    if (name === 'head') headCalls++;
    return read(name);
  };
  selected.collections.clearSchemaRecordCache();
  reader.resolve(ids[0]!);
  const coldHeads = headCalls;
  assert.ok(coldHeads > 0);
  selected.collections.clearSchemaRecordCache();
  let selectedId: string | undefined,
    selectedIndex = 0,
    busy = false,
    fired = 0;
  f.authority.storage.read = (name) => {
    const bytes = read(name);
    if (name === 'head' && selectedId && !busy && ++headCalls === coldHeads) {
      busy = true;
      try {
        assert.equal(reader.resolve(selectedId).kind, 'q'.repeat(7900) + selectedIndex);
        fired++;
      } finally {
        busy = false;
      }
    }
    return bytes;
  };
  for (let n = 0; n < ids.length; n++) {
    headCalls = 0;
    selectedId = ids[n]!;
    selectedIndex = n;
    assert.equal(reader.resolve(selectedId).kind, 'q'.repeat(7900) + n);
    selectedId = undefined;
  }
  assert.equal(
    fired,
    30,
    'each same-key reentry occurs at the final physical proof before outer admission',
  );
  f.authority.storage.read = read;
  const beforeNewest = intakeWorkCounters(f.db).warm.collectionItemsRead;
  assert.equal(reader.resolve(ids.at(-1)!).kind, 'q'.repeat(7900) + 29);
  assert.equal(intakeWorkCounters(f.db).warm.collectionItemsRead - beforeNewest, 0);
  const beforeOldest = intakeWorkCounters(f.db).warm.collectionItemsRead;
  assert.equal(reader.resolve(ids[0]!).kind, 'q'.repeat(7900) + 0);
  assert.ok(
    intakeWorkCounters(f.db).warm.collectionItemsRead > beforeOldest,
    'encoded key/header/proof bytes evict before the 32-entry maximum',
  );
});
