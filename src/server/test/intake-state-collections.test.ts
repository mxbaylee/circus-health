import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { transaction, clinicalReviewRevision } from '../database.ts';
import { recordDurabilityStatus } from '../record-versions.ts';
import {
  ensureIntakeFrontierObserver,
  intakeFrontierAttemptCounts,
} from '../intake-lookup-frontier-observer.ts';
import {
  createIntakeStateStorage,
  clearIntakeStateCache,
  type IntakeCollectionChange,
  type PreparedIntakeCollectionMutation,
} from '../intake-state-storage.ts';
import {
  intakeNamespace,
  COLLECTION_FORMAT,
  type IntakeCollectionHead,
} from '../intake-state-evidence.ts';
import { readIntakeLogSequence } from '../intake-state-log.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { setImmediate } from 'node:timers/promises';
import {
  prepareInitialIntakeEnvelope,
  readIntakeEnvelopeMaterialized,
} from '../intake-authority.ts';
import {
  intakeCollectionsContributorFixture as fixture,
  mutateCollection as mutate,
  prepareCollectionMutation,
  withCollectionAdmission,
  collectionStoreWithMetaReadProbe,
} from './helpers/intake-collections-contributor-fixture.ts';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

test('retained byte consumption refuses a changed logical generation even when its bytes remain selected', async (t) => {
  const { db, identity } = fixture(t),
    store = createIntakeStateStorage(db, identity).collections,
    expected = Buffer.alloc(3 * 4096, 'f');
  await mutate(
    db,
    store,
    [
      ...Array.from({ length: 3 }, () => ({
        area: 'builds' as const,
        collection: 'bytes',
        op: 'appendBytes' as const,
        bytes: expected.subarray(0, 4096),
      })),
      {
        area: 'logical',
        collection: 'values',
        op: 'putBytes',
        key: 'detail',
        fromArea: 'builds',
        fromCollection: 'bytes',
      },
    ],
    1,
  );
  const value = store.get(store.openView(), 'logical', 'values', 'detail');
  assert.ok(value && typeof value !== 'string');
  const first = store.readBytes(value, { items: 1, bytes: 4096 });
  assert.deepEqual(first.chunks, [expected.subarray(0, 4096)]);
  await setImmediate();
  await mutate(
    db,
    store,
    [{ area: 'logical', collection: 'summary', op: 'put', key: 'status', value: 'reviewed' }],
    2,
  );
  // Test consumption before the descriptor assertion: a refusing descriptor must
  // not invalidate the registry and accidentally conceal a successful old read.
  const beforeRefusal = intakeWorkCounters(db).warm.collectionByteChunkReads;
  assert.throws(
    () => store.readBytes(value, { after: first.after!, items: 1, bytes: 4096 }),
    /stale|expired/,
  );
  assert.equal(
    intakeWorkCounters(db).warm.collectionByteChunkReads,
    beforeRefusal,
    'refusal precedes any old payload consumption',
  );
  const fresh = store.get(store.openView(), 'logical', 'values', 'detail');
  assert.ok(fresh && typeof fresh !== 'string');
  assert.deepEqual(
    store.readBytes(fresh, { items: 3, bytes: expected.length }).chunks,
    Array.from({ length: 3 }, () => expected.subarray(0, 4096)),
  );
});

for (const change of ['auxiliary', 'cache', 'close', 'foreign', 'forged', 'reentrant'] as const)
  test(`byte consumption preserves owner and lifetime checks: ${change}`, async (t) => {
    const { db, identity } = fixture(t),
      storage = createIntakeStateStorage(db, identity),
      store = storage.collections,
      expected = Buffer.alloc(4096, 'f');
    await mutate(
      db,
      store,
      [
        { area: 'builds', collection: 'bytes', op: 'appendBytes', bytes: expected },
        {
          area: 'logical',
          collection: 'values',
          op: 'putBytes',
          key: 'detail',
          fromArea: 'builds',
          fromCollection: 'bytes',
        },
      ],
      1,
    );
    const value = store.get(store.openView(), 'logical', 'values', 'detail');
    assert.ok(value && typeof value !== 'string');
    if (change === 'auxiliary') {
      const id = randomUUID();
      store.commitMaintenance(
        await prepareCollectionMutation(store, store.openView(), {
          operationId: id,
          requestDigest: digest(id),
          domainVersion: 1,
          changes: [
            {
              area: 'builds',
              collection: 'unrelated',
              op: 'put',
              key: 'checkpoint',
              value: 'ready',
            },
          ],
        }),
      );
      assert.deepEqual(store.readBytes(value, { items: 1, bytes: 4096 }).chunks, [expected]);
    } else if (change === 'cache') {
      clearIntakeStateCache(db);
      assert.throws(() => store.readBytes(value, { items: 1, bytes: 4096 }), /expired/);
    } else if (change === 'close') {
      storage.close();
      assert.throws(() => store.readBytes(value, { items: 1, bytes: 4096 }), /closed/);
    } else if (change === 'foreign') {
      const other = fixture(t),
        reader = createIntakeStateStorage(other.db, other.identity).collections;
      assert.throws(() => reader.readBytes(value, { items: 1, bytes: 4096 }), /foreign/);
    } else if (change === 'forged') {
      assert.throws(() => store.readBytes({ ...value }, { items: 1, bytes: 4096 }), /foreign/);
    } else {
      const operationId = randomUUID();
      const reentrant = await prepareCollectionMutation(store, store.openView(), {
        operationId,
        requestDigest: digest(operationId),
        domainVersion: 2,
        changes: [
          { area: 'logical', collection: 'summary', op: 'put', key: 'status', value: 'changed' },
        ],
      });
      let changed = false;
      assert.throws(
        () =>
          store.readBytes(value, {
            get items() {
              if (!changed) {
                changed = true;
                transaction(db, () => store.stage(reentrant));
              }
              return 1;
            },
            bytes: 4096,
          }),
        /authority changed|stale/,
      );
    }
  });

for (const unrelated of [0, 80])
  test(`bounded byte consumption counts only selected chunks: ${unrelated} unrelated entries`, async (t) => {
    const { db, identity } = fixture(t),
      store = createIntakeStateStorage(db, identity).collections;
    await mutate(
      db,
      store,
      [
        ...Array.from({ length: 3 }, () => ({
          area: 'builds' as const,
          collection: 'bytes',
          op: 'appendBytes' as const,
          bytes: Buffer.alloc(4096, 'f'),
        })),
        {
          area: 'logical',
          collection: 'values',
          op: 'putBytes',
          key: 'detail',
          fromArea: 'builds',
          fromCollection: 'bytes',
        },
      ],
      1,
    );
    for (let offset = 0; offset < unrelated; offset += 40)
      await mutate(
        db,
        store,
        Array.from({ length: Math.min(40, unrelated - offset) }, (_, n) => ({
          area: 'logical' as const,
          collection: 'unrelated',
          op: 'put' as const,
          key: String(offset + n),
          value: 'Independently fictional unrelated evidence',
        })),
        2 + offset / 40,
      );
    const value = store.get(store.openView(), 'logical', 'values', 'detail');
    assert.ok(value && typeof value !== 'string');
    const binding = store.byteValueBinding(value);
    store.readBytes(value, { items: 1, bytes: 4096 });
    const before = structuredClone(intakeWorkCounters(db));
    const page = store.readBytes(value, { items: 1, bytes: 4096 });
    assert.equal(page.bytes, 4096);
    assert.equal(page.chunks.length, 1);
    assert.equal(page.complete, false);
    const after = intakeWorkCounters(db),
      delta = (key: keyof typeof after.warm) => after.warm[key] - before.warm[key];
    assert.equal(
      delta('collectionByteChunkReads'),
      2,
      'one requested chunk plus one bounded lookahead',
    );
    assert.equal(delta('collectionByteChunkReadBytes'), 8192);
    assert.equal(
      delta('collectionReadWitnessQueries'),
      4,
      'one entry/final certificate, not a second descriptor baseline',
    );
    assert.equal(delta('collectionNodeReads'), 0);
    assert.equal(delta('collectionReadBytes'), 0);
    assert.equal(delta('hashedBytes'), 0);
    assert.equal(delta('collectionItemsRead'), 0);
    assert.equal(delta('materializationReads'), 0);
    assert.equal(delta('envelopeHydrations'), 0);
    assert.equal(delta('collectionWrittenBytes'), 0);
    assert.equal(after.primitive.frameBytesWritten, before.primitive.frameBytesWritten);
    assert.equal(after.primitive.readCopyBytes, before.primitive.readCopyBytes);
    assert.equal(store.byteValueBinding(value), binding);
    t.diagnostic(
      JSON.stringify({
        unrelated,
        returnedBytes: page.bytes,
        chunkBytes: delta('collectionByteChunkReadBytes'),
        witnessQueries: delta('collectionReadWitnessQueries'),
      }),
    );
  });

test('immutable staging makes one bounded collision read and one bounded readback per new node', async (t) => {
  const { db, identity } = fixture(t);
  const nodePrefix = intakeNamespace(identity) + 'node:';
  const boundedReads = new Map<string, number>();
  const unboundedReads = new Map<string, number>();
  const inserted = new Set<string>();
  const nativePrepare = db.prepare.bind(db);
  const nativeGet = StatementSync.prototype.get;
  let staging = false;
  const observedGet = function (this: StatementSync, ...args: unknown[]) {
    const sql = this.sourceSQL;
    if (
      sql.startsWith('SELECT length(CAST(value AS BLOB))') ||
      sql === 'SELECT value FROM main.app_meta WHERE key=?'
    ) {
      const reads = sql.startsWith('SELECT length(CAST(value AS BLOB))')
        ? boundedReads
        : unboundedReads;
      const key = args.at(-1);
      if (staging && typeof key === 'string' && key.startsWith(nodePrefix))
        reads.set(key, (reads.get(key) ?? 0) + 1);
    }
    return Reflect.apply(nativeGet, this, args);
  };
  t.mock.method(db, 'prepare', (sql: string) => {
    const statement = nativePrepare(sql);
    Object.defineProperty(statement, 'get', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => Reflect.apply(observedGet, statement, args),
    });
    if (sql === 'INSERT INTO app_meta(key,value) VALUES(?,?)') {
      const run = statement.run;
      statement.run = (...args) => {
        const result = Reflect.apply(run, statement, args);
        const key = args[0];
        if (staging && typeof key === 'string' && key.startsWith(nodePrefix)) inserted.add(key);
        return result;
      };
    }
    return statement;
  });
  const store = collectionStoreWithMetaReadProbe(t, db, identity, observedGet);
  await mutate(
    db,
    store,
    [{ area: 'logical', collection: 'fictional', op: 'put', key: 'first', value: 'before' }],
    1,
  );
  const operationId = randomUUID();
  const prepared = await prepareCollectionMutation(store, store.openView(), {
    operationId,
    requestDigest: digest(operationId),
    domainVersion: 2,
    changes: [
      { area: 'logical', collection: 'fictional', op: 'put', key: 'first', value: 'after' },
      { area: 'logical', collection: 'fictional', op: 'put', key: 'second', value: 'fictional' },
    ],
  });
  boundedReads.clear();
  unboundedReads.clear();
  inserted.clear();
  const before = intakeWorkCounters(db).warm.collectionNodesWritten;
  const result = transaction(db, () => {
    staging = true;
    try {
      return store.stage(prepared);
    } finally {
      staging = false;
    }
  });
  assert.ok(inserted.size > 0);
  for (const key of inserted) {
    assert.equal(boundedReads.get(key), 2, 'new node needs bounded collision and readback reads');
    assert.equal(unboundedReads.get(key) ?? 0, 0, 'no unbounded duplicate collision read');
  }
  assert.equal(intakeWorkCounters(db).warm.collectionNodesWritten - before, inserted.size);
  assert.equal(store.get(store.openView(), 'logical', 'fictional', 'second'), 'fictional');
  assert.deepEqual(
    await withCollectionAdmission(store, () => store.replay(operationId, digest(operationId))),
    result,
  );
});

test('immutable staging reuses an existing equal node without counting a new write', async (t) => {
  const { db, identity, rebuild } = fixture(t);
  const nodePrefix = intakeNamespace(identity) + 'node:';
  const rolledBack = new Map<string, string>();
  const secondInserts = new Set<string>();
  const nativePrepare = db.prepare.bind(db);
  let phase: 'setup' | 'rollback' | 'second' = 'setup';
  let equalKey = '';
  let equalReads = 0;
  const nativeGet = StatementSync.prototype.get;
  const observedGet = function (this: StatementSync, ...args: unknown[]) {
    if (
      this.sourceSQL.startsWith('SELECT length(CAST(value AS BLOB))') &&
      phase === 'second' &&
      args.at(-1) === equalKey
    )
      equalReads++;
    return Reflect.apply(nativeGet, this, args);
  };
  t.mock.method(db, 'prepare', (sql: string) => {
    const statement = nativePrepare(sql);
    Object.defineProperty(statement, 'get', {
      configurable: true,
      writable: true,
      value: (...args: unknown[]) => Reflect.apply(observedGet, statement, args),
    });
    if (sql === 'INSERT INTO app_meta(key,value) VALUES(?,?)') {
      const run = statement.run;
      statement.run = (...args) => {
        const result = Reflect.apply(run, statement, args);
        const [key, value] = args;
        if (typeof key === 'string' && key.startsWith(nodePrefix) && typeof value === 'string') {
          if (phase === 'rollback') rolledBack.set(key, value);
          if (phase === 'second') secondInserts.add(key);
        }
        return result;
      };
    }
    return statement;
  });
  const store = collectionStoreWithMetaReadProbe(t, db, identity, observedGet);
  await mutate(
    db,
    store,
    [{ area: 'logical', collection: 'fictional', op: 'put', key: 'first', value: 'before' }],
    1,
  );
  const selectedBefore = store.binding(store.openView());
  const operationId = randomUUID();
  const changes: IntakeCollectionChange[] = [
    { area: 'logical', collection: 'fictional', op: 'put', key: 'first', value: 'after' },
  ];
  const candidate = async () =>
    await prepareCollectionMutation(store, store.openView(), {
      operationId,
      requestDigest: digest(operationId),
      domainVersion: 2,
      changes,
    });
  const first = await candidate();
  assert.throws(
    () =>
      transaction(db, () => {
        phase = 'rollback';
        try {
          store.stage(first);
          throw Error('fictional rollback');
        } finally {
          phase = 'setup';
        }
      }),
    /fictional rollback/,
  );
  assert.ok(rolledBack.size > 0);
  const [key, equalValue] = rolledBack.entries().next().value!;
  equalKey = key;
  transaction(db, () => {
    db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(equalKey, equalValue);
  });
  assert.deepEqual(store.binding(store.openView()), selectedBefore);
  const second = await candidate();
  const before = intakeWorkCounters(db).warm.collectionNodesWritten;
  const result = transaction(db, () => {
    phase = 'second';
    try {
      return store.stage(second);
    } finally {
      phase = 'setup';
    }
  });
  assert.equal(equalReads, 2, 'equal node still receives collision and readback checks');
  assert.equal(secondInserts.has(equalKey), false);
  assert.equal(intakeWorkCounters(db).warm.collectionNodesWritten - before, secondInserts.size);
  assert.equal(store.get(store.openView(), 'logical', 'fictional', 'first'), 'after');
  const selectedAfter = store.binding(store.openView());
  const writesAfter = intakeWorkCounters(db).warm.collectionNodesWritten;
  assert.deepEqual(
    await withCollectionAdmission(store, () => store.replay(operationId, digest(operationId))),
    result,
  );
  assert.deepEqual(store.binding(store.openView()), selectedAfter);
  assert.equal(intakeWorkCounters(db).warm.collectionNodesWritten, writesAfter);
  const recovered = createIntakeStateStorage(rebuild(), identity).collections;
  assert.equal(recovered.get(recovered.openView(), 'logical', 'fictional', 'first'), 'after');
});

for (const failure of [
  'oversized collision row',
  'different collision row',
  'changed readback',
] as const)
  test(`immutable staging refuses ${failure} without publishing a head`, async (t) => {
    const { db, identity } = fixture(t);
    const nodePrefix = intakeNamespace(identity) + 'node:';
    const inserted = new Set<string>();
    const nativePrepare = db.prepare.bind(db);
    const nativeGet = StatementSync.prototype.get;
    let staging = false;
    let injected = false;
    const observedGet = function (this: StatementSync, ...args: unknown[]) {
      const row = Reflect.apply(nativeGet, this, args);
      if (!this.sourceSQL.startsWith('SELECT length(CAST(value AS BLOB))')) return row;
      const key = args.at(-1);
      if (!staging || injected || typeof key !== 'string' || !key.startsWith(nodePrefix))
        return row;
      if (failure === 'oversized collision row' && row === undefined) {
        assert.equal(args[0], 32 * 1024);
        injected = true;
        return { bytes: 32 * 1024 + 1, value: undefined };
      }
      if (failure === 'different collision row' && row === undefined) {
        assert.equal(args[0], 32 * 1024);
        injected = true;
        return { bytes: 19, value: 'different fictional' };
      }
      if (failure === 'changed readback' && inserted.has(key) && row) {
        injected = true;
        return { ...row, value: 'tampered fictional node' };
      }
      return row;
    };
    t.mock.method(db, 'prepare', (sql: string) => {
      const statement = nativePrepare(sql);
      Object.defineProperty(statement, 'get', {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) => Reflect.apply(observedGet, statement, args),
      });
      if (sql === 'INSERT INTO app_meta(key,value) VALUES(?,?)') {
        const run = statement.run;
        statement.run = (...args) => {
          const result = Reflect.apply(run, statement, args);
          const key = args[0];
          if (staging && typeof key === 'string' && key.startsWith(nodePrefix)) inserted.add(key);
          return result;
        };
      }
      return statement;
    });
    const store = collectionStoreWithMetaReadProbe(t, db, identity, observedGet);
    await mutate(
      db,
      store,
      [{ area: 'logical', collection: 'fictional', op: 'put', key: 'first', value: 'before' }],
      1,
    );
    const before = store.binding(store.openView());
    const operationId = randomUUID();
    const prepared = await prepareCollectionMutation(store, store.openView(), {
      operationId,
      requestDigest: digest(operationId),
      domainVersion: 2,
      changes: [
        { area: 'logical', collection: 'fictional', op: 'put', key: 'first', value: 'after' },
      ],
    });
    assert.throws(
      () =>
        transaction(db, () => {
          staging = true;
          try {
            store.stage(prepared);
          } finally {
            staging = false;
          }
        }),
      failure === 'oversized collision row'
        ? /stored row bytes/
        : failure === 'different collision row'
          ? /immutable collision/
          : /staged readback/,
    );
    assert.equal(injected, true);
    assert.deepEqual(store.binding(store.openView()), before);
    assert.equal(store.get(store.openView(), 'logical', 'fictional', 'first'), 'before');
    assert.equal(
      await withCollectionAdmission(store, () => store.replay(operationId, digest(operationId))),
      undefined,
    );
  });

test('v4 selected maps, sequences and byte chunks survive accepted-journal rebuild without v3 hydration', async (t) => {
  const { db, identity, rebuild } = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  const id = randomUUID();
  const first = await mutate(
    db,
    store,
    [
      {
        area: 'logical',
        collection: 'members',
        op: 'put',
        key: 'report-🌿',
        value: '{"filename":"report-🌿.pdf"}',
      },
      { area: 'logical', collection: 'events', op: 'append', value: 'first' },
      {
        area: 'builds',
        collection: 'raw',
        op: 'appendBytes',
        bytes: Buffer.from('fictional bytes\0🌿'),
      },
    ],
    1,
    id,
  );
  assert.equal(first.storageSequence, 1);
  const before = store.binding(store.openView())!;
  const noop = await mutate(db, store, [], 1);
  assert.equal(noop.changed, false);
  assert.equal(noop.storageSequence, 2);
  const after = store.binding(store.openView())!;
  assert.deepEqual(after.logical, before.logical);
  if (after.format === COLLECTION_FORMAT && before.format === COLLECTION_FORMAT) {
    assert.notDeepEqual(after.receipts, before.receipts);
    assert.notDeepEqual(after.history, before.history);
  } else {
    assert.equal(after.format, 'health-intake-state-v5');
    assert.equal(before.format, 'health-intake-state-v5');
    const evidence = (head: IntakeCollectionHead) =>
      readIntakeLogSequence(
        JSON.stringify(head),
        identity,
        (hash) =>
          db
            .prepare('SELECT value FROM app_meta WHERE key=?')
            .get(intakeNamespace(identity) + 'node:' + hash)?.value,
        head.storageSequence,
        { assertCurrent() {} },
      );
    // V5 co-locates these exact roles in one authenticated carry forest.
    assert.notDeepEqual(evidence(after).receipt, evidence(before).receipt);
    assert.notDeepEqual(evidence(after).transition, evidence(before).transition);
  }
  assert.deepEqual(await withCollectionAdmission(store, () => store.replay(id, digest(id))), first);
  await withCollectionAdmission(store, () =>
    assert.throws(() => store.replay(id, digest('conflict')), /replay conflict/),
  );
  const next = rebuild(),
    recovered = createIntakeStateStorage(next, identity).collections;
  const view = recovered.openView();
  assert.equal(
    recovered.get(view, 'logical', 'members', 'report-🌿'),
    '{"filename":"report-🌿.pdf"}',
  );
  assert.deepEqual(
    recovered
      .range(view, 'logical', 'events', { items: 10, bytes: 100 })
      .items.map((item) => item.value),
    ['first'],
  );
  const rawChunk = recovered.get(view, 'builds', 'raw', '0000000000000000');
  assert.equal(typeof rawChunk, 'string');
  assert.equal(Buffer.from(rawChunk as string, 'base64').toString(), 'fictional bytes\0🌿');
  assert.deepEqual(
    await withCollectionAdmission(recovered, () => recovered.replay(id, digest(id))),
    first,
  );
  const work = intakeWorkCounters(next);
  assert.equal(work.warm.envelopeHydrations, 0);
  assert.equal(work.warm.materializationReads, 0);
  assert.equal(work.warm.evidenceReplayVersions, 0);
});

test('unchanged collection reads authenticate selected roots once per SQLite state', async (t) => {
  const { db, identity } = fixture(t),
    store = createIntakeStateStorage(db, identity).collections;
  await mutate(
    db,
    store,
    [{ area: 'logical', collection: 'small', op: 'put', key: 'key', value: 'fictional' }],
    1,
  );
  const operationId = randomUUID();
  store.commitMaintenance(
    await prepareCollectionMutation(store, store.openView(), {
      operationId,
      requestDigest: digest(operationId),
      domainVersion: 1,
      changes: [{ area: 'builds', collection: 'small', op: 'put', key: 'key', value: 'auxiliary' }],
    }),
  );
  const view = store.openView();
  assert.equal(store.get(view, 'logical', 'small', 'key'), 'fictional');
  const before = { ...intakeWorkCounters(db).warm };
  for (let index = 0; index < 32; index++)
    assert.equal(store.get(view, 'logical', 'small', 'key'), 'fictional');
  const after = intakeWorkCounters(db).warm;
  assert.equal(
    after.collectionNodeReads - before.collectionNodeReads,
    0,
    'an exact sealed per-call certificate avoids repeated directory and value SQL reads',
  );
  assert.equal(after.collectionNodeCacheHits - before.collectionNodeCacheHits, 64);
  assert.equal(
    after.collectionReadWitnessQueries - before.collectionReadWitnessQueries,
    128,
    '32 entry/final four-query seals; minting borrows that certificate instead of taking another baseline',
  );
  t.diagnostic(
    JSON.stringify({
      nodeReads: after.collectionNodeReads - before.collectionNodeReads,
      cacheHits: after.collectionNodeCacheHits - before.collectionNodeCacheHits,
      witnessQueries: after.collectionReadWitnessQueries - before.collectionReadWitnessQueries,
      readBytes: after.collectionReadBytes - before.collectionReadBytes,
      hashedBytes: after.hashedBytes - before.hashedBytes,
    }),
  );
});

test('selected root memo refuses local, external and rolled-back corruption without explicit cache clearing', async (t) => {
  const { db, identity } = fixture(t),
    store = createIntakeStateStorage(db, identity).collections;
  await mutate(
    db,
    store,
    [{ area: 'logical', collection: 'small', op: 'put', key: 'key', value: 'first' }],
    1,
  );
  const prefix = intakeNamespace(identity),
    firstHead = String(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(prefix + 'head')!.value,
    );
  await mutate(
    db,
    store,
    [{ area: 'logical', collection: 'small', op: 'put', key: 'key', value: 'second' }],
    2,
  );
  const operationId = randomUUID();
  store.commitMaintenance(
    await prepareCollectionMutation(store, store.openView(), {
      operationId,
      requestDigest: digest(operationId),
      domainVersion: 2,
      changes: [{ area: 'builds', collection: 'small', op: 'put', key: 'key', value: 'auxiliary' }],
    }),
  );
  const selected = store.binding(store.openView())!,
    read = () => store.get(store.openView(), 'logical', 'small', 'key'),
    change = db.prepare('UPDATE app_meta SET value=? WHERE key=?');
  assert.equal(read(), 'second');
  for (const root of [
    selected.logical.root,
    selected.builds,
    ...(selected.format === COLLECTION_FORMAT
      ? [selected.history, selected.receipts]
      : // V5 receipts and transitions share one selected peak commitment.
        // Corrupt that actual root once; V4 retains both independent roots.
        [selected.peaks].map((hash) => (hash ? { hash } : null))),
  ]) {
    assert.ok(root);
    db.exec('SAVEPOINT fictional_corrupt_root');
    try {
      change.run('{}', prefix + 'node:' + root.hash);
      assert.throws(
        read,
        /schema|tree|collection|log/,
        'even an unrelated selected root is revalidated after a write',
      );
    } finally {
      db.exec('ROLLBACK TO fictional_corrupt_root; RELEASE fictional_corrupt_root');
    }
    assert.equal(read(), 'second');
  }
  db.exec('SAVEPOINT fictional_head_aba');
  try {
    change.run(firstHead, prefix + 'head');
    assert.equal(read(), 'first');
  } finally {
    db.exec('ROLLBACK TO fictional_head_aba; RELEASE fictional_head_aba');
  }
  assert.equal(read(), 'second', 'rollback restores the exact selected head');
  db.exec('SAVEPOINT fictional_owner');
  try {
    change.run('other-profile', 'owner_profile_id');
    assert.throws(read, /owner/);
  } finally {
    db.exec('ROLLBACK TO fictional_owner; RELEASE fictional_owner');
  }
  assert.equal(read(), 'second');
  const peer = new DatabaseSync(String(db.prepare('PRAGMA database_list').get()!.file)),
    key =
      prefix +
      'node:' +
      (selected.format === COLLECTION_FORMAT ? selected.receipts!.hash : selected.peaks!),
    original = String(db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)!.value);
  try {
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', key);
    assert.throws(read, /schema|tree|collection|log/, 'external corruption changes data_version');
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(original, key);
    assert.equal(read(), 'second');
    for (const oversized of ['f'.repeat(32769), '🌿'.repeat(9000)]) {
      if (oversized.startsWith('🌿')) assert.ok(oversized.length < 32768);
      peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(oversized, key);
      assert.throws(read, /collection stored row bytes/, 'the atomic bound measures UTF-8 bytes');
      peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(original, key);
      assert.equal(read(), 'second');
    }
  } finally {
    peer.close();
  }
  change.run('{}', key);
  db.exec('SAVEPOINT fictional_temporary_root_repair');
  try {
    change.run(original, key);
    assert.equal(read(), 'second', 'temporary valid bytes may be read inside the savepoint');
    const changes = db.prepare('SELECT total_changes() AS count').get()!.count;
    db.exec('ROLLBACK TO fictional_temporary_root_repair; RELEASE fictional_temporary_root_repair');
    assert.equal(db.prepare('SELECT total_changes() AS count').get()!.count, changes);
    assert.throws(
      read,
      /schema|tree|collection|log/,
      'rollback must not reuse transaction-authenticated roots',
    );
  } finally {
    if (db.isTransaction)
      db.exec(
        'ROLLBACK TO fictional_temporary_root_repair; RELEASE fictional_temporary_root_repair',
      );
    change.run(original, key);
  }
  assert.equal(read(), 'second');
  const reopened = createIntakeStateStorage(db, identity).collections;
  assert.equal(reopened.get(reopened.openView(), 'logical', 'small', 'key'), 'second');
});

test('selected incomplete chunks publish without clinical invalidation and promote atomically as large values', async (t) => {
  const { db, identity, rebuild } = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  await mutate(
    db,
    store,
    [{ area: 'logical', collection: 'summary', op: 'put', key: 'status', value: 'pending' }],
    1,
  );
  const logical = store.binding(store.openView())!.logical;
  const revision = clinicalReviewRevision(db);
  const expected = Buffer.alloc(24 * 1024, 'f');
  for (let offset = 0; offset < expected.length; offset += 4096) {
    const id = randomUUID();
    const prepared = await prepareCollectionMutation(store, store.openView(), {
      operationId: id,
      requestDigest: digest(id),
      domainVersion: 1,
      changes: [
        {
          area: 'builds',
          collection: 'large-metadata',
          op: 'appendBytes',
          bytes: expected.subarray(offset, offset + 4096),
        },
      ],
    });
    store.commitMaintenance(prepared);
    assert.equal(clinicalReviewRevision(db), revision);
    assert.deepEqual(store.binding(store.openView())!.logical, logical);
  }
  // Attach a snapshot, then append another build chunk in the same preparation.
  // Both roots must remain reachable without copying the selected byte payload.
  await mutate(
    db,
    store,
    [
      {
        area: 'logical',
        collection: 'members',
        op: 'putBytes',
        key: 'large',
        fromArea: 'builds',
        fromCollection: 'large-metadata',
      },
      {
        area: 'builds',
        collection: 'large-metadata',
        op: 'appendBytes',
        bytes: Buffer.from('later'),
      },
      {
        area: 'logical',
        collection: 'published-metadata',
        op: 'adoptCollection',
        fromArea: 'builds',
        fromCollection: 'large-metadata',
      },
    ],
    2,
  );
  assert.ok(clinicalReviewRevision(db) > revision);
  const next = rebuild(),
    recovered = createIntakeStateStorage(next, identity).collections;
  const view = recovered.openView(),
    value = recovered.get(view, 'logical', 'members', 'large');
  assert.ok(value && typeof value !== 'string');
  assert.equal(value.bytes, expected.length);
  const chunks: Buffer[] = [];
  let after: string | undefined;
  for (;;) {
    const page = recovered.readBytes(value, { after, items: 2, bytes: 8192 });
    chunks.push(...page.chunks);
    if (page.complete) break;
    after = page.after!;
  }
  assert.deepEqual(Buffer.concat(chunks), expected);
  assert.equal(
    recovered.collection(view, 'logical', 'published-metadata')!.bytes,
    expected.length + 5,
  );
  assert.throws(
    () => recovered.readBytes({ ...value } as typeof value, { items: 1, bytes: 4096 }),
    /foreign or expired/,
  );
});

test('v4 mutations remain path-local, ranges are bounded, unchanged puts preserve logical roots', async (t) => {
  const { db, identity } = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  for (let start = 0; start < 512; start += 32)
    await mutate(
      db,
      store,
      Array.from({ length: 32 }, (_, offset) => ({
        area: 'logical' as const,
        collection: 'members',
        op: 'put' as const,
        key: String(start + offset).padStart(5, '0'),
        value: 'fictional-' + (start + offset),
      })),
      start / 32 + 1,
    );
  clearIntakeStateCache(db);
  const before = intakeWorkCounters(db).warm;
  let view = store.openView();
  assert.equal(store.get(view, 'logical', 'members', '00255'), 'fictional-255');
  const read = intakeWorkCounters(db).warm;
  assert.ok(read.collectionNodeReads - before.collectionNodeReads < 20);
  assert.equal(read.serializedBytes - before.serializedBytes, 0);
  const page = store.range(view, 'logical', 'members', { after: '00255', items: 3, bytes: 160 });
  assert.deepEqual(
    page.items.map((item) => item.key),
    ['00256', '00257', '00258'],
  );
  assert.equal(page.count, 512);
  assert.equal(page.complete, false);
  const basis = store.binding(view)!;
  const noop = await mutate(
    db,
    store,
    [{ area: 'logical', collection: 'members', op: 'put', key: '00255', value: 'fictional-255' }],
    16,
  );
  assert.equal(noop.changed, false);
  assert.deepEqual(store.binding(store.openView())!.logical, basis.logical);
  const restored = await mutate(
    db,
    store,
    [
      { area: 'logical', collection: 'members', op: 'delete', key: '00255' },
      { area: 'logical', collection: 'members', op: 'put', key: '00255', value: 'fictional-255' },
    ],
    16,
  );
  assert.equal(restored.changed, false);
  assert.deepEqual(store.binding(store.openView())!.logical, basis.logical);
  const baseline = intakeWorkCounters(db).warm;
  await mutate(
    db,
    store,
    [
      {
        area: 'logical',
        collection: 'members',
        op: 'put',
        key: '00255',
        value: 'changed fictional',
      },
    ],
    17,
  );
  const changed = intakeWorkCounters(db).warm;
  assert.ok(changed.collectionNodesWritten - baseline.collectionNodesWritten < 40);
  assert.equal(changed.envelopeHydrations - baseline.envelopeHydrations, 0);
  assert.throws(() => store.get(view, 'logical', 'members', '00255'), /stale collection view/);
  view = store.openView();
  assert.throws(
    () => store.range(view, 'logical', 'members', { items: 1, bytes: 1 }),
    /exceeds byte budget/,
  );
});

test('v4 preparation ownership, expiry, stale bases and rollback cannot select candidate state', async (t) => {
  const { db, identity } = fixture(t),
    other = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  const prepare = async (value: string) =>
    await prepareCollectionMutation(store, store.openView(), {
      operationId: randomUUID(),
      requestDigest: digest(value),
      domainVersion: 1,
      changes: [{ area: 'logical', collection: 'members', op: 'put', key: 'one', value }],
    });
  const first = await prepare('original');
  assert.throws(() => store.stage(first), /requires application transaction/);
  assert.throws(() => transaction(db, () => store.stage(first)), /expired/);
  const pending = await prepare('rolled back');
  assert.throws(
    () =>
      transaction(db, () => {
        store.stage(pending);
        throw Error('fictional rollback');
      }),
    /fictional rollback/,
  );
  assert.equal(store.binding(store.openView()), undefined);
  const next = await prepare('retained');
  assert.throws(
    () =>
      transaction(other.db, () =>
        createIntakeStateStorage(other.db, other.identity).collections.stage(next),
      ),
    /foreign or expired/,
  );
  transaction(db, () => store.stage(next));
  const stale = await prepareCollectionMutation(store, store.openView(), {
    operationId: randomUUID(),
    requestDigest: digest('stale'),
    domainVersion: 2,
    changes: [{ area: 'logical', collection: 'members', op: 'put', key: 'two', value: 'second' }],
  });
  await mutate(db, store, [], 1);
  assert.throws(() => transaction(db, () => store.stage(stale)), /stale collection preparation/);
  const many: PreparedIntakeCollectionMutation[] = [];
  for (let index = 0; index < 9; index++)
    many.push(
      await prepareCollectionMutation(store, store.openView(), {
        operationId: randomUUID(),
        requestDigest: digest(String(index)),
        domainVersion: 1,
        changes: [],
      }),
    );
  assert.throws(() => store.inspectPrepared(many[0]!), /expired/);
});

test('v4 rejects missing/forged pages and v3/v4 access is explicit', async (t) => {
  const { db, identity, rebuild } = fixture(t);
  const full = createIntakeStateStorage(db, identity),
    store = full.collections;
  await mutate(
    db,
    store,
    [{ area: 'logical', collection: 'members', op: 'put', key: 'one', value: 'fictional' }],
    1,
  );
  assert.throws(() => full.read(), /schema/);
  const view = store.openView(),
    root = store.binding(view)!.logical.root!;
  transaction(db, () =>
    db
      .prepare('UPDATE app_meta SET value=? WHERE key=?')
      .run('{}', intakeNamespace(identity) + 'node:' + root.hash),
  );
  clearIntakeStateCache(db);
  assert.throws(() => store.get(store.openView(), 'logical', 'members', 'one'), /schema/);
  const next = rebuild(),
    recovered = createIntakeStateStorage(next, identity).collections;
  assert.throws(() => recovered.get(recovered.openView(), 'logical', 'members', 'one'), /schema/);
  const legacy = fixture(t),
    v3 = createIntakeStateStorage(legacy.db, legacy.identity);
  v3.mutate({ retained: 'v3' }, randomUUID());
  assert.throws(() => v3.collections.openView(), /schema/);
  assert.deepEqual(v3.read(), { retained: 'v3' });
});

test('v4 uncertain durable publication clears preparations and rebuild follows selected evidence', async (t) => {
  const { db, identity, rebuild, ambiguous } = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  await mutate(
    db,
    store,
    [{ area: 'logical', collection: 'members', op: 'put', key: 'one', value: 'first' }],
    1,
  );
  const prepared = await prepareCollectionMutation(store, store.openView(), {
    operationId: randomUUID(),
    requestDigest: digest('second'),
    domainVersion: 2,
    changes: [{ area: 'logical', collection: 'members', op: 'put', key: 'one', value: 'second' }],
  });
  ambiguous();
  assert.throws(() => transaction(db, () => store.stage(prepared)), /ambiguous/);
  const next = rebuild(),
    selected = createIntakeStateStorage(next, identity).collections;
  assert.equal(selected.get(selected.openView(), 'logical', 'members', 'one'), 'second');
});

test('oversized inline metadata refuses before serialization and escaped overflow leaves selected state intact', async (t) => {
  const { db, identity } = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  await mutate(
    db,
    store,
    [{ area: 'logical', collection: 'members', op: 'put', key: 'one', value: 'fictional' }],
    1,
  );
  const before = store.binding(store.openView());
  const stringify = JSON.stringify;
  let oversizedSerializations = 0;
  t.mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => {
    const value = args[0];
    if (value?.kind === 'inline' && typeof value.text === 'string' && value.text.length > 8192)
      oversizedSerializations++;
    return Reflect.apply(stringify, JSON, args);
  });
  for (const value of ['f'.repeat(100_000), '\0'.repeat(2000)]) {
    await store.admitCurrentLogAsync();
    assert.throws(
      () =>
        store.prepare(store.openView(), {
          operationId: randomUUID(),
          requestDigest: digest('oversized'),
          domainVersion: 2,
          changes: [{ area: 'logical', collection: 'members', op: 'put', key: 'oversized', value }],
        }),
      /requires byte chunks/,
    );
    store.releaseLogAdmission();
    assert.deepEqual(store.binding(store.openView()), before);
  }
  assert.equal(oversizedSerializations, 0);
});

for (const raw of [false, true]) {
  test(`supported v3 ${raw ? 'raw duplicate' : 'normalized unknown'} evidence bridges without changing clinical revision or legacy reads`, async (t) => {
    const { db, identity, rebuild, acceptedHead } = fixture(t);
    const full = createIntakeStateStorage(db, identity),
      store = full.collections;
    const input = raw
      ? '{"unknown":1,"unknown":2,"intake":{"version":7,"originalName":"first.txt"},"intake":{"version":7,"originalName":"last.txt","workflow":{"format":"health-intake-workflow-v1","candidates":[]}}}'
      : {
          untouched: { unknown: ['fictional', { nested: true }] },
          intake: {
            version: 7,
            originalName: 'fictional.txt',
            workflow: { format: 'health-intake-workflow-v1', candidates: [] },
          },
        };
    const initial = prepareInitialIntakeEnvelope(input);
    const originalOperation = randomUUID();
    transaction(db, () => {
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(
        initial.detailsJson,
        identity.intakeId,
      );
      full.stage(initial.state, originalOperation);
    });
    assert.equal(
      db.prepare('SELECT details_json FROM source_files WHERE id=?').get(identity.intakeId)
        ?.details_json,
      initial.detailsJson,
    );
    const status = recordDurabilityStatus(db);
    assert.ok(status?.configured && !status.dirty && !status.conflicted);
    const head = db
      .prepare('SELECT head_json FROM __record_state WHERE singleton=1')
      .get()?.head_json;
    assert.equal(typeof head, 'string');
    assert.deepEqual(acceptedHead(), Buffer.from(head + '\n'));
    assert.equal(intakeFrontierAttemptCounts(db), undefined);
    ensureIntakeFrontierObserver(db);
    const source = { id: identity.intakeId, kind: 'intake_original', sha256: identity.sourceHash };
    const before = readIntakeEnvelopeMaterialized(db, source);
    const oldReceipt = db
      .prepare('SELECT value FROM app_meta WHERE key=?')
      .get(intakeNamespace(identity) + 'operation:' + originalOperation)!.value;
    const revision = clinicalReviewRevision(db);
    assert.throws(
      () =>
        store.prepareLegacyBridge({
          operationId: randomUUID(),
          requestDigest: digest('wrong-version'),
          domainVersion: 8,
        }),
      /initial selection/,
    );
    const operationId = randomUUID();
    const bridge = store.prepareLegacyBridge({
      operationId,
      requestDigest: digest(operationId),
      domainVersion: 7,
    });
    const result = store.commitMaintenance(bridge);
    assert.equal(result.changed, false);
    assert.equal(result.logical.domainVersion, 7);
    assert.equal(clinicalReviewRevision(db), revision);
    assert.equal(
      db
        .prepare('SELECT value FROM app_meta WHERE key=?')
        .get(intakeNamespace(identity) + 'operation:' + originalOperation)!.value,
      oldReceipt,
    );
    const after = readIntakeEnvelopeMaterialized(db, source);
    assert.equal(after.text, before.text);
    assert.deepEqual(after.value, before.value);
    const work = intakeWorkCounters(db).reconstruction;
    for (let index = 0; index < 3; index++) {
      const id = randomUUID();
      const prepared = await prepareCollectionMutation(store, store.openView(), {
        operationId: id,
        requestDigest: digest(id),
        domainVersion: 7,
        changes: [
          {
            area: 'builds',
            collection: 'migration.checkpoints',
            op: 'append',
            value: String(index),
          },
        ],
      });
      store.commitMaintenance(prepared);
      assert.equal(readIntakeEnvelopeMaterialized(db, source).text, before.text);
    }
    assert.equal(
      intakeWorkCounters(db).reconstruction.evidenceReplayVersions,
      work.evidenceReplayVersions,
    );
    assert.equal(clinicalReviewRevision(db), revision);
    const next = rebuild();
    assert.equal(readIntakeEnvelopeMaterialized(next, source).text, before.text);
  });
}

test('nested snapshots preserve immutable contents, reject ordinary reads and bind capabilities to selected logical state', async (t) => {
  const { db, identity, rebuild } = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  await mutate(
    db,
    store,
    [
      { area: 'builds', collection: 'members', op: 'put', key: 'first', value: 'retained' },
      {
        area: 'logical',
        collection: 'catalog',
        op: 'putCollection',
        key: 'version-1',
        fromArea: 'builds',
        fromCollection: 'members',
      },
    ],
    1,
  );
  let cap = store.getCollectionReference(store.openView(), 'logical', 'catalog', 'version-1')!;
  assert.equal(store.getReferenced(cap, 'first'), 'retained');
  assert.equal(store.rankReferenced(cap, 'first'), 0);
  assert.equal(store.rankReferenced(cap, 'second'), 1);
  assert.throws(() => store.rankReferenced({ ...cap }, 'second'), /foreign, stale or expired/);
  assert.throws(
    () => store.get(store.openView(), 'logical', 'catalog', 'version-1'),
    /nested collection/,
  );
  assert.throws(
    () => store.range(store.openView(), 'logical', 'catalog', { items: 10, bytes: 8192 }),
    /nested collection/,
  );
  assert.throws(() => store.getReferenced({ ...cap }, 'first'), /foreign, stale or expired/);
  cap = store.getCollectionReference(store.openView(), 'logical', 'catalog', 'version-1')!;
  const id = randomUUID();
  store.commitMaintenance(
    await prepareCollectionMutation(store, store.openView(), {
      operationId: id,
      requestDigest: digest(id),
      domainVersion: 1,
      changes: [{ area: 'builds', collection: 'members', op: 'put', key: 'second', value: 'new' }],
    }),
  );
  assert.equal(store.getReferenced(cap, 'second'), undefined);
  assert.equal(store.getReferenced(cap, 'first'), 'retained');
  await mutate(
    db,
    store,
    [
      {
        area: 'logical',
        collection: 'catalog',
        op: 'putCollection',
        key: 'version-2',
        fromArea: 'builds',
        fromCollection: 'members',
      },
      { area: 'logical', collection: 'fork', op: 'adoptReferenced', value: cap },
    ],
    2,
  );
  assert.throws(() => store.getReferenced(cap, 'first'), /foreign, stale or expired/);
  assert.throws(() => store.rankReferenced(cap, 'second'), /foreign, stale or expired/);
  assert.equal(store.get(store.openView(), 'logical', 'fork', 'second'), undefined);
  const reopened = createIntakeStateStorage(rebuild(), identity).collections;
  const old = reopened.getCollectionReference(
    reopened.openView(),
    'logical',
    'catalog',
    'version-1',
  )!;
  const next = reopened.getCollectionReference(
    reopened.openView(),
    'logical',
    'catalog',
    'version-2',
  )!;
  assert.deepEqual(
    reopened.rangeReferenced(old, { items: 10, bytes: 8192 }).items.map((i) => i.key),
    ['first'],
  );
  assert.deepEqual(
    reopened.rangeReferenced(next, { items: 10, bytes: 8192 }).items.map((i) => i.key),
    ['first', 'second'],
  );
  clearIntakeStateCache(db);
  assert.throws(() => store.getReferenced(next, 'first'), /foreign, stale or expired/);
});

test('live collection views survive unrelated reader churn and still expire at authority boundaries', async (t) => {
  const { db, identity } = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  await mutate(
    db,
    store,
    [{ area: 'logical', collection: 'members', op: 'put', key: 'one', value: 'first' }],
    1,
  );
  const selected = store.openView();
  // Other bounded readers can open and discard many views while an in-flight
  // reader still owns its exact logical view. Handle creation changes no authority.
  for (let index = 0; index < 256; index++) {
    const other = createIntakeStateStorage(db, identity).collections;
    assert.equal(other.get(other.openView(), 'logical', 'members', 'one'), 'first');
  }
  assert.equal(store.get(selected, 'logical', 'members', 'one'), 'first');
  await mutate(
    db,
    store,
    [{ area: 'logical', collection: 'members', op: 'put', key: 'one', value: 'second' }],
    2,
  );
  assert.throws(() => store.get(selected, 'logical', 'members', 'one'), /stale collection view/);
  const current = store.openView();
  assert.equal(store.get(current, 'logical', 'members', 'one'), 'second');
  clearIntakeStateCache(db);
  assert.throws(
    () => store.get(current, 'logical', 'members', 'one'),
    /foreign or expired collection view/,
  );
  const reopened = createIntakeStateStorage(db, identity).collections;
  assert.equal(reopened.get(reopened.openView(), 'logical', 'members', 'one'), 'second');
});

test('prefix-scoped collection ranges preserve page boundaries and reject foreign cursors', async (t) => {
  const { db, identity } = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  const changes: IntakeCollectionChange[] = [
    ...['a:0', 'h:0', 'h:1', 'h:2'].map((key) => ({
      area: 'logical' as const,
      collection: 'scoped',
      op: 'put' as const,
      key,
      value: key,
    })),
    {
      area: 'logical',
      collection: 'scoped',
      op: 'put',
      key: 'z:0',
      value: 'unrelated'.repeat(800),
    },
  ];
  await mutate(db, store, changes, 1);
  const view = store.openView();
  const first = store.range(view, 'logical', 'scoped', {
    after: 'h:',
    prefix: 'h:',
    items: 2,
    bytes: 100,
  });
  assert.deepEqual(
    first.items.map((item) => item.key),
    ['h:0', 'h:1'],
  );
  assert.equal(first.complete, false);
  assert.equal(first.after, 'h:1');
  assert.equal(first.count, 5, 'count remains the whole collection count, not a scope count');
  const last = store.range(view, 'logical', 'scoped', {
    after: first.after!,
    prefix: 'h:',
    items: 2,
    bytes: 100,
  });
  assert.deepEqual(
    last.items.map((item) => item.key),
    ['h:2'],
  );
  assert.equal(last.complete, true, 'outside-prefix values do not exhaust the scoped byte window');
  assert.equal(last.after, null);
  const empty = store.range(view, 'logical', 'scoped', {
    after: 'q:',
    prefix: 'q:',
    items: 1,
    bytes: 1,
  });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.complete, true);
  assert.equal(empty.bytes, 0);
  const whole = store.range(view, 'logical', 'scoped', { after: 'h:', items: 10, bytes: 32768 });
  assert.deepEqual(
    whole.items.map((item) => item.key),
    ['h:0', 'h:1', 'h:2', 'z:0'],
  );
  assert.throws(
    () =>
      store.range(store.openView(), 'logical', 'scoped', {
        after: 'a:',
        prefix: 'h:',
        items: 1,
        bytes: 100,
      }),
    /prefix/,
  );
  assert.throws(
    () =>
      store.range(store.openView(), 'logical', 'scoped', { prefix: 'h:', items: 1, bytes: 100 }),
    /prefix/,
  );
  assert.throws(
    () =>
      store.range(store.openView(), 'logical', 'scoped', {
        after: 'h:',
        prefix: 'h:',
        items: 1,
        bytes: 1,
      }),
    /byte budget/,
  );
});

for (const history of [0, 128])
  test(`bounded map preparation shares paths for one 64-change run: ${history} retained entries`, async (t) => {
    const { db, identity, rebuild } = fixture(t);
    const store = createIntakeStateStorage(db, identity).collections;
    let version = 0;
    for (let offset = 0; offset < history; offset += 64)
      await mutate(
        db,
        store,
        Array.from({ length: 64 }, (_, i) => ({
          area: 'logical',
          collection: 'batched',
          op: 'put',
          key: `a${String(offset + i).padStart(4, '0')}`,
          value: `retained-${offset + i}`,
        })),
        ++version,
      );
    const changes: IntakeCollectionChange[] = Array.from({ length: 64 }, (_, i) => ({
      area: 'logical',
      collection: 'batched',
      op: 'put',
      key: `z${String((i * 37) % 64).padStart(4, '0')}`,
      value: `new-${(i * 37) % 64}`,
    }));
    const id = randomUUID(),
      view = store.openView();
    await store.admitCurrentLogAsync();
    const before = { ...intakeWorkCounters(db).warm };
    const prepared = store.prepare(view, {
      operationId: id,
      requestDigest: digest(id),
      domainVersion: ++version,
      changes,
    });
    store.releaseLogAdmission();
    const after = { ...intakeWorkCounters(db).warm };
    const measured = {
      reads: after.collectionNodeReads - before.collectionNodeReads,
      preparedBytes: after.collectionPreparedBytes - before.collectionPreparedBytes,
    };
    t.diagnostic(JSON.stringify({ history, ...measured }));
    // The bounded new suffix has one shared old-tree path. These generous work
    // ceilings distinguish a batched walk from reading/copying it for every key.
    assert.ok(measured.reads < 96, 'one map run must not reread the shared old path per key');
    assert.ok(
      measured.preparedBytes < 128 * 1024,
      'one map run must not serialize intermediate roots per key',
    );
    const result = transaction(db, () => store.stage(prepared));
    const expected = [
      ...Array.from({ length: history }, (_, i) => ({
        key: `a${String(i).padStart(4, '0')}`,
        value: `retained-${i}`,
      })),
      ...Array.from({ length: 64 }, (_, i) => ({
        key: `z${String(i).padStart(4, '0')}`,
        value: `new-${i}`,
      })),
    ];
    const readAll = (s: typeof store) => {
      const v = s.openView();
      const rows: ReturnType<typeof s.range>['items'] = [];
      let cursor: string | null = null;
      do {
        const page = s.range(v, 'logical', 'batched', {
          items: 32,
          bytes: 64 * 1024,
          ...(cursor ? { after: cursor } : {}),
        });
        rows.push(...page.items);
        cursor = page.after;
      } while (cursor);
      return rows;
    };
    assert.deepEqual(readAll(store), expected);
    assert.deepEqual(
      await withCollectionAdmission(store, () => store.replay(id, digest(id))),
      result,
    );
    const cold = createIntakeStateStorage(rebuild(), identity).collections;
    assert.deepEqual(readAll(cold), expected);
    assert.deepEqual(
      await withCollectionAdmission(cold, () => cold.replay(id, digest(id))),
      result,
    );
  });

test('map batching stops at reference, adoption and delete barriers and preserves exact no-op replay', async (t) => {
  const { db, identity, rebuild } = fixture(t),
    store = createIntakeStateStorage(db, identity).collections;
  await mutate(
    db,
    store,
    [
      { area: 'logical', collection: 'items', op: 'put', key: 'a', value: 'first' },
      { area: 'logical', collection: 'items', op: 'put', key: 'a', value: 'second' },
      { area: 'logical', collection: 'items', op: 'put', key: 'b', value: 'before' },
      {
        area: 'logical',
        collection: 'snapshots',
        op: 'putCollection',
        key: 'old',
        fromArea: 'logical',
        fromCollection: 'items',
      },
      { area: 'logical', collection: 'items', op: 'delete', key: 'a' },
      { area: 'logical', collection: 'items', op: 'put', key: 'a', value: 'third' },
      { area: 'logical', collection: 'items', op: 'put', key: 'c', value: 'later' },
      {
        area: 'builds',
        collection: 'copy',
        op: 'adoptCollection',
        fromArea: 'logical',
        fromCollection: 'items',
      },
      { area: 'logical', collection: 'items', op: 'put', key: 'a', value: 'final' },
    ],
    1,
  );
  const inspect = (selected: typeof store) => {
    const view = selected.openView();
    assert.equal(selected.get(view, 'logical', 'items', 'a'), 'final');
    assert.equal(selected.get(view, 'builds', 'copy', 'a'), 'third');
    const reference = selected.getCollectionReference(view, 'logical', 'snapshots', 'old')!;
    assert.equal(selected.getReferenced(reference, 'a'), 'second');
    assert.equal(selected.getReferenced(reference, 'c'), undefined);
    assert.equal(selected.range(view, 'logical', 'items', { items: 10, bytes: 2048 }).count, 3);
  };
  inspect(store);
  const id = randomUUID();
  const before = store.binding(store.openView())!.logical;
  const result = await mutate(
    db,
    store,
    [
      { area: 'logical', collection: 'items', op: 'put', key: 'a', value: 'temporary long value' },
      { area: 'logical', collection: 'items', op: 'put', key: 'a', value: 'final' },
    ],
    1,
    id,
  );
  assert.equal(result.changed, false);
  assert.deepEqual(store.binding(store.openView())!.logical, before);
  assert.deepEqual(
    await withCollectionAdmission(store, () => store.replay(id, digest(id))),
    result,
  );
  const cold = createIntakeStateStorage(rebuild(), identity).collections;
  inspect(cold);
  assert.deepEqual(await withCollectionAdmission(cold, () => cold.replay(id, digest(id))), result);
});

for (const inTransaction of [false, true])
  for (const unrelated of [0, 80])
    test(`collection preparation ${inTransaction ? 'retains raw transaction reads' : 'authenticates unchanged pages once within its own seal'}: ${unrelated}`, async (t) => {
      const { db, identity } = fixture(t);
      const prefix = intakeNamespace(identity) + 'node:';
      let probing = false;
      const reads = new Map<string, number>();
      const nativeGet = StatementSync.prototype.get;
      const observedGet = function (this: StatementSync, ...args: unknown[]) {
        const row = Reflect.apply(nativeGet, this, args);
        if (this.sourceSQL.startsWith('SELECT length(CAST(value AS BLOB))')) {
          const key = args.at(-1);
          // The namespace also contains V5 carry nodes. This oracle measures
          // the unchanged collection AVL pages counted by collectionNodeReads.
          if (
            probing &&
            typeof key === 'string' &&
            key.startsWith(prefix) &&
            typeof row?.value === 'string' &&
            JSON.parse(row.value).format === 'health-intake-node-v4'
          )
            reads.set(key, (reads.get(key) ?? 0) + 1);
        }
        return row;
      };
      const nativePrepare = db.prepare.bind(db);
      t.mock.method(db, 'prepare', (sql: string) => {
        const statement = nativePrepare(sql);
        Object.defineProperty(statement, 'get', {
          configurable: true,
          writable: true,
          value: (...args: unknown[]) => Reflect.apply(observedGet, statement, args),
        });
        return statement;
      });
      const store = collectionStoreWithMetaReadProbe(t, db, identity, observedGet);
      for (let start = 0; start < 64 + unrelated; start += 64)
        await mutate(
          db,
          store,
          Array.from({ length: Math.min(64, 64 + unrelated - start) }, (_, n) => ({
            area: 'logical' as const,
            collection: 'values',
            op: 'put' as const,
            key: String(start + n).padStart(3, '0'),
            value: `fictional-${start + n}`,
          })),
          1,
        );
      const operationId = randomUUID(),
        view = store.openView();
      await store.admitCurrentLogAsync();
      let nodeReads = 0,
        aggregateNodeReads = 0,
        certificateNodeReads = 0;
      const prepareMeasured = () => {
        const before = intakeWorkCounters(db).warm;
        probing = true;
        try {
          return store.prepare(view, {
            operationId,
            requestDigest: digest(operationId),
            domainVersion: 2,
            changes: Array.from({ length: 32 }, (_, n) => ({
              area: 'logical' as const,
              collection: 'values',
              op: 'put' as const,
              key: String(n).padStart(3, '0'),
              value: `changed-${n}`,
            })),
          });
        } finally {
          const after = intakeWorkCounters(db).warm;
          aggregateNodeReads = after.collectionNodeReads - before.collectionNodeReads;
          certificateNodeReads = after.vaultCertificatePageReads - before.vaultCertificatePageReads;
          // Genuine accepted authority also reads its private certificate tree.
          // Preserve full aggregate accounting; reconcile this selected-page
          // SQL oracle with the independently exposed certificate subset removed.
          nodeReads = aggregateNodeReads - certificateNodeReads;
          probing = false;
          store.releaseLogAdmission();
        }
      };
      const result = inTransaction
        ? transaction(db, () => store.stage(prepareMeasured()))
        : (() => {
            const prepared = prepareMeasured();
            return transaction(db, () => store.stage(prepared));
          })();
      t.diagnostic(
        JSON.stringify({
          inTransaction,
          unrelated,
          distinct: reads.size,
          reads: [...reads.values()].reduce((a, b) => a + b, 0),
          maxReads: Math.max(...reads.values()),
          nodeReads,
          aggregateNodeReads,
          certificateNodeReads,
        }),
      );
      for (let n = 0; n < 64 + unrelated; n++)
        assert.equal(
          store.get(store.openView(), 'logical', 'values', String(n).padStart(3, '0')),
          n < 32 ? `changed-${n}` : `fictional-${n}`,
        );
      assert.deepEqual(
        await withCollectionAdmission(store, () => store.replay(operationId, digest(operationId))),
        result,
      );
      assert.ok(reads.size > 0, 'the preparation authenticates actual retained pages');
      assert.equal(
        [...reads.values()].reduce((sum, n) => sum + n, 0),
        nodeReads,
        'actual SQL reads reconcile with the public preparation work counter',
      );
      if (inTransaction)
        assert.ok(
          Math.max(...reads.values()) > 1,
          'transaction-bound preparation must not borrow the optimistic page certificate',
        );
      else
        assert.equal(
          Math.max(...reads.values()),
          1,
          'no unchanged node is fetched twice within this bounded preparation',
        );
    });
