import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, transaction, clinicalReviewRevision, type Database } from '../database.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  type RecordStorage,
} from '../record-versions.ts';
import {
  createIntakeStateStorage,
  clearIntakeStateCache,
  type IntakeCollectionChange,
  type PreparedIntakeCollectionMutation,
} from '../intake-state-storage.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import {
  prepareInitialIntakeEnvelope,
  readIntakeEnvelopeMaterialized,
} from '../intake-authority.ts';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-collection-state-'));
  const objects = new Map<string, Buffer>();
  let ambiguous = false;
  const storage: RecordStorage = {
    read: (name) => (objects.has(name) ? Buffer.from(objects.get(name)!) : null),
    writeImmutable: (name, bytes) => {
      assert.equal(objects.has(name), false);
      objects.set(name, Buffer.from(bytes));
    },
    publishHead: (bytes) => {
      objects.set('head', Buffer.from(bytes));
      if (ambiguous) throw Error('fictional ambiguous publication');
    },
  };
  const identity = {
    profileId: 'fictional-collections',
    intakeId: 'fictional-package',
    sourceHash: '2'.repeat(64),
  };
  const db = openDatabase(join(root, 'current.sqlite'), identity.profileId);
  const dbs: Database[] = [db];
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(identity.intakeId, 'fictional.zip', identity.sourceHash, 0, 'intake_original', '{}');
  attachRecordDurability(db, { profileId: identity.profileId, storage });
  const rebuild = () => {
    const path = join(root, randomUUID() + '.sqlite');
    rebuildRecordDatabase(path, { profileId: identity.profileId, storage });
    const next = openDatabase(path, identity.profileId);
    attachRecordDurability(next, { profileId: identity.profileId, storage });
    dbs.push(next);
    return next;
  };
  t.after(() => {
    for (const item of dbs) {
      clearIntakeStateCache(item);
      if (item.isOpen) item.close();
    }
    rmSync(root, { recursive: true, force: true });
  });
  return {
    db,
    identity,
    rebuild,
    ambiguous: () => {
      ambiguous = true;
    },
  };
}
function mutate(
  db: Database,
  store: ReturnType<typeof createIntakeStateStorage>['collections'],
  changes: IntakeCollectionChange[],
  version: number,
  id = randomUUID(),
) {
  const prepared = store.prepare(store.openView(), {
    operationId: id,
    requestDigest: digest(id),
    domainVersion: version,
    changes,
  });
  return transaction(db, () => store.stage(prepared));
}

test('v4 selected maps, sequences and byte chunks survive accepted-journal rebuild without v3 hydration', (t) => {
  const { db, identity, rebuild } = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  const id = randomUUID();
  const first = mutate(
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
  const noop = mutate(db, store, [], 1);
  assert.equal(noop.changed, false);
  assert.equal(noop.storageSequence, 2);
  const after = store.binding(store.openView())!;
  assert.deepEqual(after.logical, before.logical);
  assert.notDeepEqual(after.receipts, before.receipts);
  assert.notDeepEqual(after.history, before.history);
  assert.deepEqual(store.replay(id, digest(id)), first);
  assert.throws(() => store.replay(id, digest('conflict')), /replay conflict/);
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
  assert.deepEqual(recovered.replay(id, digest(id)), first);
  const work = intakeWorkCounters(next);
  assert.equal(work.warm.envelopeHydrations, 0);
  assert.equal(work.warm.materializationReads, 0);
  assert.equal(work.warm.evidenceReplayVersions, 0);
});

test('unchanged collection reads authenticate selected roots once per SQLite state', (t) => {
  const { db, identity } = fixture(t),
    store = createIntakeStateStorage(db, identity).collections;
  mutate(
    db,
    store,
    [{ area: 'logical', collection: 'small', op: 'put', key: 'key', value: 'fictional' }],
    1,
  );
  const operationId = randomUUID();
  store.commitMaintenance(
    store.prepare(store.openView(), {
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
    64,
    'each point read authenticates its directory and value page without unrelated root rereads',
  );
  t.diagnostic(
    JSON.stringify({
      nodeReads: after.collectionNodeReads - before.collectionNodeReads,
      readBytes: after.collectionReadBytes - before.collectionReadBytes,
      hashedBytes: after.hashedBytes - before.hashedBytes,
    }),
  );
});

test('selected root memo refuses local, external and rolled-back corruption without explicit cache clearing', (t) => {
  const { db, identity } = fixture(t),
    store = createIntakeStateStorage(db, identity).collections;
  mutate(
    db,
    store,
    [{ area: 'logical', collection: 'small', op: 'put', key: 'key', value: 'first' }],
    1,
  );
  const prefix = intakeNamespace(identity),
    firstHead = String(
      db.prepare('SELECT value FROM app_meta WHERE key=?').get(prefix + 'head')!.value,
    );
  mutate(
    db,
    store,
    [{ area: 'logical', collection: 'small', op: 'put', key: 'key', value: 'second' }],
    2,
  );
  const operationId = randomUUID();
  store.commitMaintenance(
    store.prepare(store.openView(), {
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
    selected.history,
    selected.receipts,
  ]) {
    assert.ok(root);
    db.exec('SAVEPOINT fictional_corrupt_root');
    try {
      change.run('{}', prefix + 'node:' + root.hash);
      assert.throws(
        read,
        /schema|tree|collection/,
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
    key = prefix + 'node:' + selected.receipts!.hash,
    original = String(db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)!.value);
  try {
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', key);
    assert.throws(read, /schema|tree|collection/, 'external corruption changes data_version');
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
      /schema|tree|collection/,
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

test('selected incomplete chunks publish without clinical invalidation and promote atomically as large values', (t) => {
  const { db, identity, rebuild } = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  mutate(
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
    const prepared = store.prepare(store.openView(), {
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
  mutate(
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

test('v4 mutations remain path-local, ranges are bounded, unchanged puts preserve logical roots', (t) => {
  const { db, identity } = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  for (let start = 0; start < 512; start += 32)
    mutate(
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
  const noop = mutate(
    db,
    store,
    [{ area: 'logical', collection: 'members', op: 'put', key: '00255', value: 'fictional-255' }],
    16,
  );
  assert.equal(noop.changed, false);
  assert.deepEqual(store.binding(store.openView())!.logical, basis.logical);
  const restored = mutate(
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
  mutate(
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

test('v4 preparation ownership, expiry, stale bases and rollback cannot select candidate state', (t) => {
  const { db, identity } = fixture(t),
    other = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  const prepare = (value: string) =>
    store.prepare(store.openView(), {
      operationId: randomUUID(),
      requestDigest: digest(value),
      domainVersion: 1,
      changes: [{ area: 'logical', collection: 'members', op: 'put', key: 'one', value }],
    });
  const first = prepare('original');
  assert.throws(() => store.stage(first), /requires application transaction/);
  assert.throws(() => transaction(db, () => store.stage(first)), /expired/);
  const pending = prepare('rolled back');
  assert.throws(
    () =>
      transaction(db, () => {
        store.stage(pending);
        throw Error('fictional rollback');
      }),
    /fictional rollback/,
  );
  assert.equal(store.binding(store.openView()), undefined);
  const next = prepare('retained');
  assert.throws(
    () =>
      transaction(other.db, () =>
        createIntakeStateStorage(other.db, other.identity).collections.stage(next),
      ),
    /foreign or expired/,
  );
  transaction(db, () => store.stage(next));
  const stale = store.prepare(store.openView(), {
    operationId: randomUUID(),
    requestDigest: digest('stale'),
    domainVersion: 2,
    changes: [{ area: 'logical', collection: 'members', op: 'put', key: 'two', value: 'second' }],
  });
  mutate(db, store, [], 1);
  assert.throws(() => transaction(db, () => store.stage(stale)), /stale collection preparation/);
  const many: PreparedIntakeCollectionMutation[] = [];
  for (let index = 0; index < 9; index++)
    many.push(
      store.prepare(store.openView(), {
        operationId: randomUUID(),
        requestDigest: digest(String(index)),
        domainVersion: 1,
        changes: [],
      }),
    );
  assert.throws(() => store.inspectPrepared(many[0]!), /expired/);
});

test('v4 rejects missing/forged pages and v3/v4 access is explicit', (t) => {
  const { db, identity, rebuild } = fixture(t);
  const full = createIntakeStateStorage(db, identity),
    store = full.collections;
  mutate(
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

test('v4 uncertain durable publication clears preparations and rebuild follows selected evidence', (t) => {
  const { db, identity, rebuild, ambiguous } = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  mutate(
    db,
    store,
    [{ area: 'logical', collection: 'members', op: 'put', key: 'one', value: 'first' }],
    1,
  );
  const prepared = store.prepare(store.openView(), {
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

test('oversized inline metadata refuses before serialization and escaped overflow leaves selected state intact', (t) => {
  const { db, identity } = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  mutate(
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
    assert.deepEqual(store.binding(store.openView()), before);
  }
  assert.equal(oversizedSerializations, 0);
});

for (const raw of [false, true]) {
  test(`supported v3 ${raw ? 'raw duplicate' : 'normalized unknown'} evidence bridges without changing clinical revision or legacy reads`, (t) => {
    const { db, identity, rebuild } = fixture(t);
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
      const prepared = store.prepare(store.openView(), {
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

test('nested snapshots preserve immutable contents, reject ordinary reads and bind capabilities to selected logical state', (t) => {
  const { db, identity, rebuild } = fixture(t);
  const store = createIntakeStateStorage(db, identity).collections;
  mutate(
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
    store.prepare(store.openView(), {
      operationId: id,
      requestDigest: digest(id),
      domainVersion: 1,
      changes: [{ area: 'builds', collection: 'members', op: 'put', key: 'second', value: 'new' }],
    }),
  );
  assert.equal(store.getReferenced(cap, 'second'), undefined);
  assert.equal(store.getReferenced(cap, 'first'), 'retained');
  mutate(
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
