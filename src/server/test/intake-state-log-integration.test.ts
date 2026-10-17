import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { prepareInitialIntakeEnvelope } from '../intake-authority.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { parseSchemaControl } from '../intake-envelope-schema.ts';
import {
  encodeIntakeReferencedEnvelope,
  INTAKE_REFERENCED_ENVELOPE_FORMAT,
} from '../intake-referenced-envelope-codec.ts';
import { withAcceptedNativeIntakeSourceFormat } from '../intake-accepted-source-format.ts';
import {
  captureReferencedEnvelopeReadFromFormat,
  closeReferencedEnvelopeRead,
  referencedEnvelopeCurrentSelection,
} from '../intake-referenced-envelope-access.ts';
import { createIntakeStateStorage } from '../intake-state-storage.ts';
import { transaction } from '../database.ts';
import {
  registerRecordIntakeLogPublication,
  consumeAcceptedRecordIntakeLogPublication,
  type RecordIntakeLogPublication,
} from '../record-versions.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import {
  hashWork,
  initializeIntakeLog,
  rebuildIntakeLogSnapshot,
  cacheIntakeLogSnapshot,
  disposeIntakeLogSnapshot,
  intakeLogResidencyStats,
} from '../intake-state-log.ts';
import {
  intakeCollectionsContributorFixture,
  mutateCollection,
  prepareCollectionMutation,
  withCollectionAdmission,
} from './helpers/intake-collections-contributor-fixture.ts';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

for (const count of [8, 32])
  test(`actual selected V5 writer keeps ${count} owned progress publications linear`, async (t) => {
    const f = intakeCollectionsContributorFixture(t);
    const store = createIntakeStateStorage(f.db, f.identity).collections;
    const prefix = intakeNamespace(f.identity);
    const receipts: Awaited<ReturnType<typeof mutateCollection>>[] = [];
    const beforeHashes = hashWork.calls;
    for (let n = 0; n < count; n++) receipts.push(await mutateCollection(f.db, store, [], 0));
    const warmHashes = hashWork.calls - beforeHashes;
    // Any cold suffix verification on each publication exceeds this bounded
    // carry/root work allowance; original storage's own hashes are separate.
    assert.ok(warmHashes <= 14 * count, `${warmHashes} codec hashes for ${count} writes`);
    const rows = f.db
      .prepare('SELECT key,value FROM app_meta WHERE key GLOB ?')
      .all(prefix + 'node:*');
    let bits = 0;
    for (let value = count; value; value = Math.floor(value / 2)) bits += value % 2;
    assert.equal(rows.length, 3 * count - bits);
    assert.ok(
      rows.every(
        (row) => JSON.parse(String(row.value)).format === 'health-intake-state-log-node-v1',
      ),
    );
    const versions = f.db
      .prepare(
        "SELECT count(*) AS n FROM __record_versions WHERE entity='app_meta' AND json_extract(contents_json,'$.key') GLOB ?",
      )
      .get(prefix + 'node:*')!;
    assert.equal(versions.n, rows.length, 'each immutable codec row is accepted once');
    await withCollectionAdmission(store, () => {
      for (const receipt of receipts)
        assert.deepEqual(store.replay(receipt.operationId, digest(receipt.operationId)), receipt);
      assert.equal(store.replay(randomUUID(), digest('fictional absent operation')), undefined);
    });
    const rebuilt = f.rebuild();
    const cold = createIntakeStateStorage(rebuilt, f.identity).collections;
    await withCollectionAdmission(cold, () => {
      for (const receipt of receipts)
        assert.deepEqual(cold.replay(receipt.operationId, digest(receipt.operationId)), receipt);
    });
    t.diagnostic(
      JSON.stringify({ count, immutableRows: rows.length, warmCodecHashes: warmHashes }),
    );
  });

test('same-head descendant corruption and repair cannot renew an active negative lookup lease', async (t) => {
  const f = intakeCollectionsContributorFixture(t);
  const store = createIntakeStateStorage(f.db, f.identity).collections;
  const first = await mutateCollection(f.db, store, [], 0);
  await mutateCollection(f.db, store, [], 0);
  await store.admitCurrentLogAsync();
  const prefix = intakeNamespace(f.identity);
  const leaf = f.db
    .prepare(
      "SELECT key,value FROM app_meta WHERE key GLOB ? AND json_extract(value,'$.kind')='leaf' ORDER BY key LIMIT 1",
    )
    .get(prefix + 'node:*')!;
  const peer = new DatabaseSync(f.db.location()!);
  try {
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', leaf.key);
    assert.throws(() => store.replay(randomUUID(), digest('fictional negative')));
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(leaf.value, leaf.key);
    assert.throws(() => store.replay(randomUUID(), digest('fictional repaired negative')));
  } finally {
    peer.close();
    store.releaseLogAdmission();
  }
  await withCollectionAdmission(store, () => {
    assert.deepEqual(store.replay(first.operationId, digest(first.operationId)), first);
    assert.equal(store.replay(randomUUID(), digest('fictional fresh negative')), undefined);
  });
});

test('pending preparation survives private-index eviction then genuine stage and publication', async (t) => {
  const f = intakeCollectionsContributorFixture(t);
  const store = createIntakeStateStorage(f.db, f.identity).collections;
  const operationId = randomUUID();
  const requestDigest = digest(operationId);
  const prepared = await prepareCollectionMutation(store, store.openView(), {
    operationId,
    requestDigest,
    domainVersion: 0,
    changes: [],
  });
  // Actual private SQLite instances force count-pressure eviction. These are
  // codec proofs only; the collection publication still uses its real owner.
  const retiredBefore = intakeLogResidencyStats().retirements;
  const scratch = [];
  for (let n = 0; n < 65; n++) {
    const cap = await rebuildIntakeLogSnapshot(
      initializeIntakeLog(f.identity).head,
      f.identity,
      () => undefined,
      { assertCurrent() {} },
    );
    cacheIntakeLogSnapshot(cap);
    scratch.push(cap);
  }
  assert.ok(intakeLogResidencyStats().retirements >= retiredBefore + 2);
  try {
    const before = f.acceptedHead();
    const accepted = transaction(f.db, () => store.stage(prepared));
    assert.notDeepEqual(f.acceptedHead(), before);
    await withCollectionAdmission(store, () => {
      assert.deepEqual(store.replay(operationId, requestDigest), accepted);
    });
    const rebuilt = f.rebuild();
    await withCollectionAdmission(createIntakeStateStorage(rebuilt, f.identity).collections, () => {
      assert.deepEqual(
        createIntakeStateStorage(rebuilt, f.identity).collections.replay(
          operationId,
          requestDigest,
        ),
        accepted,
      );
    });
  } finally {
    for (const cap of scratch) disposeIntakeLogSnapshot(cap);
  }
});

test('cancellation after owned promotion releases the unpublished resource lease and preserves exact accepted replay', async (t) => {
  const f = intakeCollectionsContributorFixture(t);
  const store = createIntakeStateStorage(f.db, f.identity).collections;
  const receipt = await mutateCollection(f.db, store, [], 0);
  const active = intakeLogResidencyStats().activeIndices;
  const hashes = hashWork.calls;
  let cancelled = false;
  let scheduled = false;
  await assert.rejects(
    store.admitCurrentLogAsync(() => {
      if (cancelled) throw Error('fictional post-promotion cancellation');
      if (!scheduled && intakeLogResidencyStats().activeIndices > active) {
        scheduled = true;
        queueMicrotask(() => {
          cancelled = true;
        });
      }
    }),
    /fictional post-promotion cancellation/,
  );
  assert.equal(scheduled, true);
  assert.equal(hashWork.calls, hashes, 'owned warm promotion performed no cold suffix hashing');
  assert.equal(intakeLogResidencyStats().activeIndices, active);
  await withCollectionAdmission(store, () => {
    assert.deepEqual(store.replay(receipt.operationId, digest(receipt.operationId)), receipt);
  });
});

test('external source and borrowed envelope scopes pin one derivative until their final close', async (t) => {
  const f = intakeCollectionsContributorFixture(t);
  const initial = prepareInitialIntakeEnvelope({
    intake: { version: 1, originalName: 'fictional.pdf', state: 'ready' },
  });
  transaction(f.db, () => {
    f.db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(initial.detailsJson, f.identity.intakeId);
    createIntakeStateStorage(f.db, f.identity).stage(initial.state, randomUUID());
  });
  await buildIntakeCollectionEnvelope(f.db, {
    id: f.identity.intakeId,
    sha256: f.identity.sourceHash,
  });
  const store = createIntakeStateStorage(f.db, f.identity).collections;
  const selected = store.binding(store.openView())!;
  assert.ok(selected.logical.root);
  const descriptor = encodeIntakeReferencedEnvelope({
    intakeAuthority: {
      format: INTAKE_REFERENCED_ENVELOPE_FORMAT,
      identity: f.identity,
      mode: parseSchemaControl(
        store.get(store.openView(), 'logical', 'envelope.control', 'representation'),
      ).mode,
      storageSequence: selected.storageSequence,
      logicalRoot: selected.logical.root,
      sourceLabel: { kind: 'missing' },
    },
  });
  transaction(f.db, () => {
    f.db
      .prepare('UPDATE source_files SET details_json=? WHERE id=?')
      .run(descriptor, f.identity.intakeId);
    f.db
      .prepare('UPDATE app_meta SET value=value WHERE key=?')
      .run(intakeNamespace(f.identity) + 'head');
  });
  store.releaseLogAdmission();
  const before = intakeLogResidencyStats().activeIndices;
  await withAcceptedNativeIntakeSourceFormat(
    f.db,
    f.identity.profileId,
    f.identity.intakeId,
    () => {},
    async (parent) => {
      const active = intakeLogResidencyStats().activeIndices;
      assert.equal(active, before + 1);
      let constructionRefusals = 0;
      for (let failureAt = 1; failureAt <= 50; failureAt++) {
        let calls = 0;
        let attempted:
          Awaited<ReturnType<typeof captureReferencedEnvelopeReadFromFormat>> | undefined;
        try {
          attempted = await captureReferencedEnvelopeReadFromFormat(
            f.db,
            parent,
            () => {
              parent.assertCurrent();
              if (++calls >= failureAt) throw Error('fictional child construction cancelled');
            },
            'current',
          );
        } catch (error) {
          assert.match(String(error), /fictional child construction cancelled/);
          constructionRefusals++;
        } finally {
          if (attempted) {
            try {
              closeReferencedEnvelopeRead(attempted);
            } catch (error) {
              assert.match(String(error), /fictional child construction cancelled/);
            }
          }
        }
        parent.assertCurrent();
        assert.equal(
          store.replay(randomUUID(), digest('fictional absent after child construction')),
          undefined,
        );
        assert.equal(intakeLogResidencyStats().activeIndices, active);
      }
      assert.ok(constructionRefusals > 0);
      let cancelled = false;
      const child = await captureReferencedEnvelopeReadFromFormat(
        f.db,
        parent,
        () => {
          parent.assertCurrent();
          if (cancelled) throw Error('fictional borrowed read cancelled');
        },
        'current',
      );
      const selection = referencedEnvelopeCurrentSelection(child);
      assert.equal(selection.identity.intakeId, f.identity.intakeId);
      cancelled = true;
      assert.throws(() => closeReferencedEnvelopeRead(child), /fictional borrowed read cancelled/);
      assert.equal(
        intakeLogResidencyStats().activeIndices,
        active,
        'parent still pins the shared index',
      );
      parent.assertCurrent();
      assert.equal(
        store.replay(randomUUID(), digest('fictional absent with live parent')),
        undefined,
      );
      const sibling = await captureReferencedEnvelopeReadFromFormat(
        f.db,
        parent,
        () => parent.assertCurrent(),
        'current',
      );
      closeReferencedEnvelopeRead(sibling);
      assert.equal(intakeLogResidencyStats().activeIndices, active);
      assert.equal(
        store.replay(randomUUID(), digest('fictional absent after sibling close')),
        undefined,
      );
    },
    true,
  );
  assert.equal(
    intakeLogResidencyStats().activeIndices,
    before,
    'last external close releases active pages',
  );
  await assert.rejects(
    withAcceptedNativeIntakeSourceFormat(
      f.db,
      f.identity.profileId,
      f.identity.intakeId,
      () => {},
      () => {
        throw Error('fictional external consumer cancelled');
      },
      true,
    ),
    /fictional external consumer cancelled/,
  );
  assert.equal(
    intakeLogResidencyStats().activeIndices,
    before,
    'consumer failure releases external pin',
  );
});

for (const cleanupFault of [false, true])
  test(`owned acceptance survives active RAM exhaustion${cleanupFault ? ' and failing cleanup' : ''}`, async (t) => {
    const f = intakeCollectionsContributorFixture(t);
    const nativeClose = DatabaseSync.prototype.close;
    let armed = false;
    if (cleanupFault)
      DatabaseSync.prototype.close = function (this: DatabaseSync) {
        const fail = armed && this.location() === null;
        Reflect.apply(nativeClose, this, []);
        if (fail) throw Error('fictional closed-then-failed derivative cleanup');
      };
    // A fresh codec instance captures the injected native cleanup method. This
    // isolates resource/owner-seal protocol; it does not certify source admission.
    const codec = await import('../intake-state-log.ts?owned-residency-' + randomUUID());
    const pool = codec.createIntakeLogResidency({ activePages: 3, cachedPages: 3 });
    const admission = { assertCurrent() {} };
    const initial = codec.initializeIntakeLog(f.identity);
    const cap = await codec.rebuildIntakeLogSnapshot(initial.head, f.identity, () => undefined, {
      ...admission,
      residency: pool,
    });
    let blocker: import('../intake-state-log.ts').IntakeLogSnapshot | undefined;
    try {
      const operationId = randomUUID();
      const previous = codec.parseHead(initial.head, f.identity);
      const receipt = {
        format: 'health-intake-state-receipt-v4' as const,
        requestDigest: digest(operationId),
        result: {
          format: 'health-intake-state-result-v4' as const,
          intakeId: f.identity.intakeId,
          operationId,
          storageSequence: 1,
          logical: previous.logical,
          changed: false,
        },
      };
      const pending = codec.prepareIntakeLogAppend(
        cap,
        {
          receipt,
          transition: {
            format: 'health-intake-state-log-transition-v1',
            operationId,
            previous,
            logical: previous.logical,
            builds: null,
          },
        },
        admission,
      );
      const prepared = codec.inspectIntakeLogAppend(pending);
      const writes = prepared.writes.map((row: { hash: string; raw: string }) => ({
        key: intakeNamespace(f.identity) + 'node:' + row.hash,
        value: row.raw,
      }));
      writes.push({ key: intakeNamespace(f.identity) + 'head', value: prepared.head });
      const binding = {
        identity: f.identity,
        beforeHead: undefined,
        afterHead: prepared.head,
        receipt,
        writes,
      };
      let publication: RecordIntakeLogPublication | undefined;
      transaction(f.db, () => {
        for (const row of writes)
          f.db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(row.key, row.value);
        publication = registerRecordIntakeLogPublication(f.db, binding);
      });
      assert.ok(publication);
      codec.cacheIntakeLogSnapshot(cap);
      blocker = await codec.rebuildIntakeLogSnapshot(initial.head, f.identity, () => undefined, {
        ...admission,
        residency: pool,
      });
      assert.equal(
        codec.isIntakeLogSnapshotResident(cap),
        true,
        'candidate is cached, not yet retired',
      );
      armed = cleanupFault;
      const result = await codec.confirmOwnedIntakeLogPublication(
        f.db,
        pending,
        publication,
        undefined,
        admission,
      );
      assert.ok(result);
      assert.equal(result.published, true);
      assert.equal(result.snapshot, null);
      assert.deepEqual(result.receipt, receipt);
      assert.equal(
        consumeAcceptedRecordIntakeLogPublication(f.db, publication, binding),
        false,
        'genuine accepted closure was consumed once',
      );
      assert.match(
        String('derivativeError' in result && result.derivativeError),
        /RAM capacity|cleanup failed/,
      );
      if (cleanupFault)
        assert.ok('derivativeError' in result && result.derivativeError instanceof AggregateError);
    } finally {
      armed = false;
      if (blocker) codec.disposeIntakeLogSnapshot(blocker);
      codec.disposeIntakeLogSnapshot(cap);
      DatabaseSync.prototype.close = nativeClose;
    }
  });

test('more than 64 source histories evict optional continuations and cold-replay the original receipt', async (t) => {
  const f = intakeCollectionsContributorFixture(t);
  const original = f.db.prepare('SELECT * FROM source_files WHERE id=?').get(f.identity.intakeId)!;
  const identities = Array.from({ length: 66 }, (_, n) => ({
    ...f.identity,
    intakeId: `fictional-source-${n}`,
  }));
  const sources = resolve(dirname(f.db.location()!), '../sources');
  for (const identity of identities)
    copyFileSync(join(sources, 'fictional.zip'), join(sources, identity.intakeId + '.zip'));
  transaction(f.db, () => {
    for (const identity of identities)
      f.db
        .prepare(
          'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
        )
        .run(
          identity.intakeId,
          dirname(String(original.path)) + '/' + identity.intakeId + '.zip',
          original.sha256,
          original.bytes,
          original.kind,
          '{}',
        );
  });
  const stores = identities.map((identity) => createIntakeStateStorage(f.db, identity).collections);
  const receipts: Awaited<ReturnType<typeof mutateCollection>>[] = [];
  let alternative: Awaited<ReturnType<typeof prepareCollectionMutation>> | undefined;
  const alternativeId = randomUUID();
  for (const store of stores) {
    receipts.push(await mutateCollection(f.db, store, [], 0));
    await withCollectionAdmission(store, () => {});
    if (store === stores[0]) {
      const input = (operationId: string) => ({
        operationId,
        requestDigest: digest(operationId),
        domainVersion: 0,
        changes: [],
      });
      alternative = await prepareCollectionMutation(store, store.openView(), input(alternativeId));
      const discarded = await prepareCollectionMutation(
        store,
        store.openView(),
        input(randomUUID()),
      );
      store.disposePreparation(discarded);
    }
    const resources = intakeLogResidencyStats();
    assert.ok(resources.cachedIndices <= 64);
    assert.ok(resources.cachedPages <= 32768);
    assert.ok(resources.activePages <= 65536);
  }
  assert.ok(alternative);
  const alternativeReceipt = transaction(f.db, () => stores[0]!.stage(alternative!));
  const head = f.acceptedHead();
  const hashes = hashWork.calls;
  await withCollectionAdmission(stores[0]!, () => {
    const receipt = receipts[0]!;
    assert.deepEqual(stores[0]!.replay(receipt.operationId, digest(receipt.operationId)), receipt);
    assert.deepEqual(stores[0]!.replay(alternativeId, digest(alternativeId)), alternativeReceipt);
    assert.equal(
      stores[0]!.replay(randomUUID(), digest('fictional absent delayed operation')),
      undefined,
    );
  });
  assert.ok(hashWork.calls > hashes, 'retired proof is rebuilt from selected evidence');
  assert.deepEqual(f.acceptedHead(), head, 'cache retirement and exact replay publish nothing');
});
