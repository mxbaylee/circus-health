import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { StatementSync } from 'node:sqlite';
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
import { intakeSchemaRecordOwner } from '../intake-state-collections.ts';
import { closeSchemaRecordCursor, stepSchemaRecordCursor } from '../intake-schema-record-stream.ts';

async function fixture(
  t: test.TestContext,
  extras = 0,
  longLexical = false,
  escapedLexical?: string,
) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-schema-resolve-authority-'));
  const path = join(root, 'current.sqlite');
  const identity = {
    profileId: 'fictional-schema-memo',
    intakeId: 'fictional-original',
    sourceHash: 'c'.repeat(64),
  };
  const db = openDatabase(path, identity.profileId);
  const authority = memoryRecordAuthority(db);
  const raw =
    '{"intake":{"version":0,"scope":{"subject":{"value":"old"},"subject":{"value":"new"}},"records":' +
    JSON.stringify(Array.from({ length: extras }, (_, id) => ({ id }))) +
    (longLexical
      ? ',"inline":"' + 'x'.repeat(2048) + '","fragmented":"' + 'y'.repeat(10000) + '"'
      : '') +
    (escapedLexical === undefined ? '' : ',"escaped":' + JSON.stringify(escapedLexical)) +
    '}}';
  const initial = prepareInitialIntakeEnvelope(raw);
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
  function nodeFor(cell: string, root = descriptor.root) {
    let ref = root;
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
    raw,
    nodes: cells.map((cell) => nodeFor(cell)),
    directoryNode: nodeFor('envelope.data', selected.head.logical.root),
  };
}

test('fixed transaction schema reads share only lexical checks and reduce counted work', async (t) => {
  const f = await fixture(t, 8, true);
  const fallback = createSchemaEnvelopeReader(
    { ...f.selected.store },
    f.control,
    f.selected.head.logical,
  );
  transaction(f.db, () => {
    const before = intakeWorkCounters(f.db).warm.collectionReadWitnessQueries;
    assert.equal(fallback.resolve(f.id).kind, f.expected);
    const middle = intakeWorkCounters(f.db).warm.collectionReadWitnessQueries;
    assert.equal(f.reader.resolve(f.id).kind, f.expected);
    const after = intakeWorkCounters(f.db).warm.collectionReadWitnessQueries;
    assert.ok((after - middle) * 2 < middle - before, `${middle - before} -> ${after - middle}`);
    assert.equal([...f.reader.recordChunks(f.reader.root())].join(''), f.raw);
    t.diagnostic(
      JSON.stringify({ fallbackWitnesses: middle - before, nativeWitnesses: after - middle }),
    );
  });
});

test('transaction schema reads do not retain roots across a savepoint rollback', async (t) => {
  const f = await fixture(t, 1);
  const node = f.nodes[0]!;
  const update = f.db.prepare('UPDATE app_meta SET value=? WHERE key=?');
  f.db.exec('SAVEPOINT fictional_outer');
  try {
    update.run('{}', node.key);
    f.db.exec('SAVEPOINT fictional_repair');
    update.run(node.raw, node.key);
    assert.equal(f.read(), f.expected);
    const before = f.db.prepare('SELECT total_changes() n').get()!.n;
    f.db.exec('ROLLBACK TO fictional_repair; RELEASE fictional_repair');
    assert.equal(f.db.prepare('SELECT total_changes() n').get()!.n, before);
    assert.throws(f.read, /tree|schema|collection/);
  } finally {
    f.db.exec('ROLLBACK TO fictional_outer; RELEASE fictional_outer');
  }
  assert.equal(f.read(), f.expected);
});

for (const boundary of [1, 2])
  for (const action of ['rollback', 'reentry'])
    test(`transaction schema read refuses ${action} at SQL witness ${boundary}`, async (t) => {
      const f = await fixture(t, 1);
      const original = StatementSync.prototype.get;
      let witnesses = 0,
        fired = false;
      try {
        assert.throws(
          () =>
            transaction(f.db, () => {
              f.db.exec('SAVEPOINT fictional_read');
              const view = f.selected.collections.openView();
              const read = () =>
                f.selected.collections.resolveSchemaRecord(
                  view,
                  f.control.mode,
                  f.control.root,
                  f.id,
                  'last',
                );
              t.mock.method(
                StatementSync.prototype,
                'get',
                function (this: StatementSync, ...args: unknown[]) {
                  const result = Reflect.apply(original, this, args);
                  if (
                    this.sourceSQL.startsWith('SELECT total_changes() AS changes,') &&
                    ++witnesses === boundary &&
                    !fired
                  ) {
                    fired = true;
                    if (action === 'rollback') f.db.exec('ROLLBACK TO fictional_read');
                    else {
                      try {
                        read();
                      } catch {}
                    }
                  }
                  return result;
                },
              );
              return read();
            }),
          /schema transaction read authority changed|collection read authority changed/,
        );
      } finally {
        t.mock.restoreAll();
      }
      assert.equal(fired, true);
    });

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

test('native record chunks share one owned read per iterator advancement', async (t) => {
  const f = await fixture(t, 16);
  const custom = createSchemaEnvelopeReader(
    { ...f.selected.store },
    f.control,
    f.selected.head.logical,
  );
  const lexicalParts = [...custom.recordChunks(custom.root())].length;
  const record = f.reader.root();
  const iterator = f.reader.recordChunks(record)[Symbol.iterator]();
  const before = structuredClone(intakeWorkCounters(f.db).warm);
  const parts: string[] = [];
  let steps = 0;
  while (true) {
    const next = iterator.next();
    steps++;
    if (next.done) break;
    assert.ok(Buffer.byteLength(next.value) <= 16 * 1024);
    parts.push(next.value);
  }
  const after = structuredClone(intakeWorkCounters(f.db).warm);
  const actual = parts.join('');
  const witnesses = after.collectionReadWitnessQueries - before.collectionReadWitnessQueries;
  assert.equal(actual, f.raw);
  assert.equal(
    createHash('sha256').update(actual).digest('hex'),
    createHash('sha256').update(f.raw).digest('hex'),
  );
  t.diagnostic(JSON.stringify({ steps, bytes: Buffer.byteLength(actual), witnesses }));
  assert.ok(lexicalParts > 64, 'the fixture exercises multiple lexical quanta');
  assert.ok(steps * 4 < lexicalParts, 'bounded batches reduce whole-call proof work');
  assert.ok(witnesses <= 4 * steps + 16, 'one whole-call witness per native iterator advancement');
});

test('native record cursor refuses a same-byte selected write during a later lexical batch', async (t) => {
  const f = await fixture(t, 16, true);
  const iterator = f.reader.recordChunks(f.reader.root())[Symbol.iterator]();
  const first = iterator.next();
  if (first.done) throw Error('Expected a first lexical batch');
  assert.ok(Buffer.byteLength(first.value) <= 16 * 1024);
  assert.ok(Buffer.byteLength(first.value) < Buffer.byteLength(f.raw));
  const original = f.authority.storage.read;
  let heads = 0;
  let changed = false;
  f.authority.storage.read = function (name) {
    if (name === 'head' && ++heads === 2) {
      const node = f.nodes[0]!;
      f.db.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run(node.raw, node.key);
      changed = true;
    }
    return original(name);
  };
  try {
    assert.throws(() => iterator.next(), /authority|head|source|storage|changed/i);
    assert.equal(changed, true);
  } finally {
    f.authority.storage.read = original;
  }
});

test('native record cursor refuses selected descriptor drift between public batches', async (t) => {
  const f = await fixture(t, 16, true);
  const iterator = f.reader.recordChunks(f.reader.root())[Symbol.iterator]();
  const first = iterator.next();
  if (first.done) throw Error('Expected a first lexical batch');
  assert.ok(Buffer.byteLength(first.value) < Buffer.byteLength(f.raw));
  f.db
    .prepare('UPDATE main.app_meta SET value=? WHERE key=?')
    .run(f.directoryNode.raw + ' ', f.directoryNode.key);
  assert.throws(() => iterator.next(), /authority|head|source|storage|changed|tree reference/i);
});

test('native cursor batches preserve escaped control, surrogate and multibyte lexical text', async (t) => {
  const escaped =
    'x'.repeat(1023) + '😀' + 'y'.repeat(20_000) + '\u0000\n\t\ud800\ud83d\ude00é'.repeat(200);
  const f = await fixture(t, 1, false, escaped);
  const custom = createSchemaEnvelopeReader(
    { ...f.selected.store },
    f.control,
    f.selected.head.logical,
  );
  const before = intakeWorkCounters(f.db).warm.collectionByteChunkReads;
  const lexicalParts = [...custom.recordChunks(custom.root())];
  const byteChunks = intakeWorkCounters(f.db).warm.collectionByteChunkReads - before;
  const original = lexicalParts.join('');
  const batches = [...f.reader.recordChunks(f.reader.root())];
  assert.ok(byteChunks > 4, 'the fragmented scalar spans stored byte chunks');
  assert.ok(original.includes('😀'), 'the pair crossing the writer split is retained');
  assert.equal(original, f.raw);
  assert.equal(batches.join(''), original);
  assert.ok(batches.length > 1);
  assert.ok(batches.every((part) => Buffer.byteLength(part) <= 16 * 1024));
});

test('a caller-seeded lexical buffer cannot enter a native read certificate', async (t) => {
  const f = await fixture(t, 1);
  const owner = intakeSchemaRecordOwner(f.selected.collections)!;
  const cursor = owner.createCursor(
    f.selected.collections.openView(),
    f.id,
    'logical',
    'envelope.data',
  )!;
  let replaced = false;
  const fakePort = {
    ...f.selected.store,
    get(key: string) {
      if (key.startsWith('c:')) {
        replaced = true;
        return 'x'.repeat(2048);
      }
      return f.selected.store.get(key);
    },
  };
  const seeded = stepSchemaRecordCursor(cursor, fakePort);
  assert.equal(seeded.done, false);
  assert.equal(seeded.value, 'x'.repeat(1024));
  assert.equal(replaced, true);
  assert.throws(() => owner.nextCursor(cursor), /tainted record cursor/);
});

test('custom and replaced record range readers keep point-operation behavior', async (t) => {
  const f = await fixture(t, 16);
  const custom = createSchemaEnvelopeReader(
    { ...f.selected.store },
    f.control,
    f.selected.head.logical,
  );
  assert.equal([...custom.recordChunks(custom.root())].join(''), f.raw);

  const iterator = f.reader.recordChunks(f.reader.root())[Symbol.iterator]();
  const first = iterator.next();
  assert.equal(first.done, false);
  const original = f.selected.collections.range;
  let calls = 0;
  f.selected.collections.range = function (...args) {
    calls++;
    return original(...args);
  };
  try {
    let actual = first.value;
    while (true) {
      const next = iterator.next();
      if (next.done) break;
      actual += next.value;
    }
    assert.equal(actual, f.raw);
    assert.ok(calls > 0, 'method replacement resumes through observable point reads');
  } finally {
    f.selected.collections.range = original;
  }
});

test('native record cursor refuses reentry during its owner proof', async (t) => {
  const f = await fixture(t, 1);
  const owner = intakeSchemaRecordOwner(f.selected.collections)!;
  const cursor = owner.createCursor(
    f.selected.collections.openView(),
    f.id,
    'logical',
    'envelope.data',
  )!;
  const original = f.authority.storage.read;
  let nestedError: unknown;
  let entered = false;
  f.authority.storage.read = function (name) {
    if (name === 'head' && !entered) {
      entered = true;
      try {
        owner.nextCursor(cursor);
      } catch (error) {
        nestedError = error;
      }
    }
    return original(name);
  };
  try {
    assert.throws(() => owner.nextCursor(cursor), /poisoned record cursor/);
    assert.equal(entered, true);
    assert.match(String(nestedError), /reentrant record cursor/);
  } finally {
    f.authority.storage.read = original;
    owner.closeCursor(cursor);
  }
});

test('native record cursor refuses a step injected during final proof', async (t) => {
  const f = await fixture(t, 16, true);
  const owner = intakeSchemaRecordOwner(f.selected.collections)!;
  const cursor = owner.createCursor(
    f.selected.collections.openView(),
    f.reader.address(f.reader.root()),
    'logical',
    'envelope.data',
  )!;
  const original = f.authority.storage.read;
  let heads = 0;
  let injected = false;
  f.authority.storage.read = function (name) {
    if (name === 'head' && ++heads === 2) {
      const extra = stepSchemaRecordCursor(cursor, f.selected.store);
      assert.equal(extra.done, false);
      injected = true;
    }
    return original(name);
  };
  try {
    let refusal: unknown;
    try {
      owner.nextCursor(cursor);
    } catch (error) {
      refusal = error;
    }
    assert.ok(refusal, `injected=${injected}; heads=${heads}`);
    assert.match(String(refusal), /record cursor authority changed/);
    assert.equal(injected, true);
  } finally {
    f.authority.storage.read = original;
    owner.closeCursor(cursor);
  }
});

test('native record cursor refuses closure injected during final proof', async (t) => {
  const f = await fixture(t, 1);
  const owner = intakeSchemaRecordOwner(f.selected.collections)!;
  const cursor = owner.createCursor(
    f.selected.collections.openView(),
    f.id,
    'logical',
    'envelope.data',
  )!;
  const original = f.authority.storage.read;
  let heads = 0;
  let closed = false;
  f.authority.storage.read = function (name) {
    if (name === 'head' && ++heads === 2) {
      closeSchemaRecordCursor(cursor);
      closed = true;
    }
    return original(name);
  };
  try {
    assert.throws(() => owner.nextCursor(cursor), /record cursor authority changed/);
    assert.equal(closed, true);
  } finally {
    f.authority.storage.read = original;
    owner.closeCursor(cursor);
  }
});

test('native record cursor refuses caught reentry from its closing SQL witness', async (t) => {
  const f = await fixture(t, 1);
  const owner = intakeSchemaRecordOwner(f.selected.collections)!;
  const cursor = owner.createCursor(
    f.selected.collections.openView(),
    f.id,
    'logical',
    'envelope.data',
  )!;
  const prototype = StatementSync.prototype as unknown as {
    get: (...parameters: unknown[]) => unknown;
    sourceSQL: string;
  };
  const original = prototype.get;
  let witnesses = 0;
  let nestedError: unknown;
  prototype.get = function (...parameters) {
    if (this.sourceSQL.includes('total_changes()') && ++witnesses === 2) {
      try {
        owner.nextCursor(cursor);
      } catch (error) {
        nestedError = error;
      }
    }
    return original.apply(this, parameters);
  };
  try {
    assert.throws(() => owner.nextCursor(cursor), /record cursor authority changed/);
    assert.match(String(nestedError), /reentrant record cursor/);
  } finally {
    prototype.get = original;
    owner.closeCursor(cursor);
  }
});

test('native record step refuses TEMP or selected-source drift before a chunk', async (t) => {
  for (const change of ['temp', 'source'] as const) {
    const f = await fixture(t, 1);
    const owner = intakeSchemaRecordOwner(f.selected.collections)!;
    const cursor = owner.createCursor(
      f.selected.collections.openView(),
      f.id,
      'logical',
      'envelope.data',
    )!;
    const original = f.authority.storage.read;
    let changed = false;
    let headReads = 0;
    f.authority.storage.read = function (name) {
      if (name === 'head') headReads++;
      if (name === 'head' && headReads === 2 && !changed) {
        changed = true;
        if (change === 'temp') f.db.exec('CREATE TEMP TABLE fictional_record_step_change(value)');
        else
          f.db
            .prepare('UPDATE source_files SET sha256=? WHERE id=?')
            .run('d'.repeat(64), f.source.id);
      }
      return original(name);
    };
    try {
      let refusal: unknown;
      try {
        owner.nextCursor(cursor);
      } catch (error) {
        refusal = error;
      }
      assert.ok(
        refusal,
        `${change} mutation did not refuse; changed=${changed}; heads=${headReads}`,
      );
      assert.match(String(refusal), /collection read authority changed|original source/);
      assert.equal(changed, true);
    } finally {
      f.authority.storage.read = original;
      owner.closeCursor(cursor);
    }
  }
});

test('native record step refuses after-entry local ABA, rollback, registry, and final HEAD loss', async (t) => {
  for (const change of [
    'logical-aba',
    'descriptor-aba',
    'rollback',
    'registry',
    'head-loss',
  ] as const) {
    const f = await fixture(t, 1);
    const owner = intakeSchemaRecordOwner(f.selected.collections)!;
    const cursor = owner.createCursor(
      f.selected.collections.openView(),
      f.id,
      'logical',
      'envelope.data',
    )!;
    const original = f.authority.storage.read;
    let headReads = 0;
    let changed = false;
    f.authority.storage.read = function (name) {
      if (name === 'head' && ++headReads === 2) {
        changed = true;
        if (change === 'head-loss') return null;
        if (change === 'registry') clearIntakeStateCache(f.db);
        else {
          const node = change === 'descriptor-aba' ? f.directoryNode : f.nodes[0]!;
          if (change === 'rollback') f.db.exec('SAVEPOINT record_step_rollback');
          f.db
            .prepare('UPDATE main.app_meta SET value=? WHERE key=?')
            .run(node.raw + ' ', node.key);
          if (change === 'rollback') f.db.exec('ROLLBACK TO record_step_rollback');
          else f.db.prepare('UPDATE main.app_meta SET value=? WHERE key=?').run(node.raw, node.key);
          if (change === 'rollback') f.db.exec('RELEASE record_step_rollback');
        }
      }
      return original(name);
    };
    try {
      assert.throws(() => owner.nextCursor(cursor), /authority|record|head|storage/i);
      assert.equal(changed, true, `${change} reached the final physical proof`);
      assert.equal(headReads, 2);
      assert.throws(() => owner.nextCursor(cursor), /foreign|poisoned|tainted|record cursor/i);
    } finally {
      f.authority.storage.read = original;
      owner.closeCursor(cursor);
    }
  }
});

test('native record step refuses an after-entry peer commit', async (t) => {
  const f = await fixture(t, 1);
  const peer = openDatabase(f.path, f.authority.profileId);
  t.after(() => {
    if (peer.isOpen) peer.close();
  });
  f.authority.attach(peer);
  const owner = intakeSchemaRecordOwner(f.selected.collections)!;
  const cursor = owner.createCursor(
    f.selected.collections.openView(),
    f.id,
    'logical',
    'envelope.data',
  )!;
  const original = f.authority.storage.read;
  let headReads = 0;
  let changed = false;
  f.authority.storage.read = function (name) {
    if (name === 'head' && ++headReads === 2) {
      changed = true;
      peer
        .prepare('UPDATE main.app_meta SET value=? WHERE key=?')
        .run(f.directoryNode.raw + ' ', f.directoryNode.key);
      peer
        .prepare('UPDATE main.app_meta SET value=? WHERE key=?')
        .run(f.directoryNode.raw, f.directoryNode.key);
    }
    return original(name);
  };
  try {
    assert.throws(() => owner.nextCursor(cursor), /authority|record|head|storage/i);
    assert.equal(changed, true);
    assert.equal(headReads, 2);
  } finally {
    f.authority.storage.read = original;
    owner.closeCursor(cursor);
  }
});

test('same-logical maintenance between native chunks preserves exact lexical bytes', async (t) => {
  const f = await fixture(t, 16);
  const iterator = f.reader.recordChunks(f.reader.root())[Symbol.iterator]();
  const first = iterator.next();
  assert.equal(first.done, false);
  const collections = f.selected.collections;
  collections.commitMaintenance(
    collections.prepare(collections.openView(), {
      operationId: randomUUID(),
      requestDigest: 'e'.repeat(64),
      domainVersion: f.selected.head.logical.domainVersion,
      changes: [
        {
          area: 'builds',
          collection: 'fictional.record.step',
          op: 'adoptCollection',
          fromArea: 'logical',
          fromCollection: 'envelope.data',
        },
      ],
    }),
  );
  let actual = first.value;
  while (true) {
    const next = iterator.next();
    if (next.done) break;
    actual += next.value;
  }
  assert.equal(actual, f.raw);
});

test('record stream retains transaction point reads and lowers total native work', async (t) => {
  const f = await fixture(t, 16);
  assert.equal(
    transaction(f.db, () => [...f.reader.recordChunks(f.reader.root())].join('')),
    f.raw,
  );

  const getPrototype = StatementSync.prototype as unknown as {
    get: (...parameters: unknown[]) => unknown;
  };
  const originalGet = getPrototype.get;
  const sample = (custom: boolean) => {
    clearIntakeStateCache(f.db);
    const selected = collectionCellReader(f.db, f.source);
    const reader = createSchemaEnvelopeReader(
      custom ? { ...selected.store } : selected.store,
      f.control,
      selected.head.logical,
    );
    const before = structuredClone(intakeWorkCounters(f.db).warm);
    let gets = 0;
    let directoryGets = 0;
    getPrototype.get = function (...parameters) {
      gets++;
      if (parameters.includes(f.directoryNode.key)) directoryGets++;
      return originalGet.apply(this, parameters);
    };
    let actual: string;
    const beforeRoot = intakeWorkCounters(f.db).warm.collectionNodeReads;
    const record = reader.root();
    const rootNodes = intakeWorkCounters(f.db).warm.collectionNodeReads - beforeRoot;
    const iterator = reader.recordChunks(record)[Symbol.iterator]();
    const iteratorNodes =
      intakeWorkCounters(f.db).warm.collectionNodeReads - beforeRoot - rootNodes;
    let terminalNodes = 0;
    const nonzeroStepNodes: number[] = [];
    try {
      const chunks: string[] = [];
      while (true) {
        const beforeNext = intakeWorkCounters(f.db).warm.collectionNodeReads;
        const next = iterator.next();
        const readNodes = intakeWorkCounters(f.db).warm.collectionNodeReads - beforeNext;
        if (readNodes && nonzeroStepNodes.length < 16) nonzeroStepNodes.push(readNodes);
        if (next.done) {
          terminalNodes = readNodes;
          break;
        }
        chunks.push(next.value);
      }
      actual = chunks.join('');
    } finally {
      getPrototype.get = originalGet;
    }
    assert.equal(actual, f.raw);
    const after = structuredClone(intakeWorkCounters(f.db).warm);
    return {
      gets,
      directoryGets,
      witnesses: after.collectionReadWitnessQueries - before.collectionReadWitnessQueries,
      nodes: after.collectionNodeReads - before.collectionNodeReads,
      rootNodes,
      iteratorNodes,
      terminalNodes,
      nonzeroStepNodes,
      items: after.collectionItemsRead - before.collectionItemsRead,
    };
  };
  const fallback = sample(true);
  const native = sample(false);
  t.diagnostic(JSON.stringify({ fallback, native }));
  assert.ok(native.witnesses < fallback.witnesses);
  assert.ok(native.gets < fallback.gets);
  // A native public batch rechecks the selected descriptor. The fallback's
  // lexical walk reads it once; the extra point lookup traverses two nodes.
  assert.equal(native.directoryGets, fallback.directoryGets + 1);
  assert.ok(native.nodes <= fallback.nodes + 2);
  assert.equal(native.items, fallback.items);
});

test('native record chunks preserve inline and fragmented lexical bytes and refuse buffered source drift', async (t) => {
  const f = await fixture(t, 1, true);
  const custom = createSchemaEnvelopeReader(
    { ...f.selected.store },
    f.control,
    f.selected.head.logical,
  );
  assert.equal([...custom.recordChunks(custom.root())].join(''), f.raw);
  const before = structuredClone(intakeWorkCounters(f.db).warm);
  const pieces = [...f.reader.recordChunks(f.reader.root())];
  const after = structuredClone(intakeWorkCounters(f.db).warm);
  assert.equal(pieces.join(''), f.raw);
  assert.ok(pieces.some((piece) => piece.includes('x'.repeat(1000))));
  assert.ok(
    after.collectionByteChunkReads > before.collectionByteChunkReads,
    'fragmented lexical value used checked byte chunks',
  );

  const iterator = f.reader.recordChunks(f.reader.root())[Symbol.iterator]();
  let buffered = false;
  while (true) {
    const next = iterator.next();
    assert.equal(next.done, false);
    if (next.value.includes('x'.repeat(1000))) {
      buffered = true;
      break;
    }
  }
  assert.equal(buffered, true);
  f.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('d'.repeat(64), f.source.id);
  assert.throws(() => iterator.next(), /original source|missing selected intake head/);
});

test('native record chunks recheck selected source before final done', async (t) => {
  const f = await fixture(t, 1);
  const root = f.reader.root();
  const chunks = [...f.reader.recordChunks(root)].length;
  const iterator = f.reader.recordChunks(root)[Symbol.iterator]();
  for (let index = 0; index < chunks; index++) assert.equal(iterator.next().done, false);
  f.db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('d'.repeat(64), f.source.id);
  assert.throws(() => iterator.next(), /original source|missing selected intake head/);
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
