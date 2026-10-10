import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { contributorAuthorityPath } from '../contributor-record-storage.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { uploadIntake, createIntakePlan } from '../intake.ts';
import { fictionalModel } from './fictional-model.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareRetainedPlanAccess, readRetainedPlanScope } from '../intake-retained-plan.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { writeIntakeSourcePin } from '../intake-source-pin.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { setCollectionProcessingException } from '../intake-processing-exceptions.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { createIntakeTree } from '../intake-state-tree.ts';
import { schemaKey } from '../intake-envelope-schema.ts';
import {
  openCollectionConversion,
  createCollectionCheckpoint,
} from '../intake-continuation-collection.ts';

async function fixture(t: test.TestContext) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-conversion-scope-')),
    profileId = 'fictional-scope',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional.txt',
    bytes: Buffer.from('Independently fictional scope source. '.repeat(1000)),
  });
  const planned = await createIntakePlan(db, root, profileId, source.id, {
    version: source.version,
  });
  const units = planned.workflow!.plans[0]!.units.map((unit) => unit.id);
  assert.ok(units.length >= 3);
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  await prepareRetainedPlanAccess(db, profileId, source.id);
  const read = (unitId?: string, sessionId = 'fictional-session') =>
    openCollectionConversion(db, root, profileId, source.id, { sessionId, unitId });
  const measured = (unitId?: string, sessionId?: string) => {
    const before = intakeWorkCounters(db).warm,
      scope = read(unitId, sessionId),
      after = intakeWorkCounters(db).warm;
    const reads = after.collectionNodeReads - before.collectionNodeReads;
    return {
      scope,
      reads,
      nodeLoads: reads + after.collectionNodeCacheHits - before.collectionNodeCacheHits,
    };
  };
  return { root, profileId, db, source, units, read, measured };
}

test('retained scope reuse preserves selection and bounded two-entry/aggregate fallback', async (t) => {
  const f = await fixture(t),
    { db, root, profileId, source, units, read, measured } = f;
  const first = measured(units[0]),
    warm = measured(units[0]);
  assert.ok(first.scope);
  assert.deepEqual(warm.scope, first.scope);
  assert.ok(warm.reads < first.reads);
  read(units[1]);
  assert.equal(measured(units[0]).reads, warm.reads);
  read(units[2]);
  const evicted = measured(units[1]);
  assert.ok(evicted.reads > warm.reads, 'third selection evicts the least-recent of two contexts');
  assert.equal(measured(units[1]).reads, warm.reads);
  assert.equal(read(undefined)?.unitId, units[0]);
  assert.equal(read(units[2])?.unitId, units[2]);
  await setCollectionProcessingException(db, root, profileId, source.id, {
    version: intakeSourceVersion(db, source.id).version,
    operationId: 'fictional-skip',
    unitId: units[0]!,
    exception: { reason: 'processing_stalled', at: '2026-10-04T00:00:00Z' },
  });
  assert.equal(read(undefined)?.unitId, units[1]);
  assert.throws(() => createCollectionCheckpoint(first.scope!), { code: 'CONVERSION_CHANGED' });
  const selected = read(units[2])!;
  assert.notEqual(read(units[2], 'fictional-other-session')!.ledgerId, selected.ledgerId);
  assert.equal(read('fictional-absent'), undefined);
  const absentFirst = measured('fictional-absent'),
    absentAgain = measured('fictional-absent');
  assert.equal(absentFirst.scope, undefined);
  assert.equal(absentAgain.scope, undefined);
  // Fresh checked lookups can reuse certified pages without reading their raw bytes.
  assert.ok(
    absentFirst.nodeLoads > warm.nodeLoads && absentAgain.nodeLoads > warm.nodeLoads,
    'absence is not memoized: ' +
      JSON.stringify({
        warm: { reads: warm.reads, nodeLoads: warm.nodeLoads },
        first: { reads: absentFirst.reads, nodeLoads: absentFirst.nodeLoads },
        again: { reads: absentAgain.reads, nodeLoads: absentAgain.nodeLoads },
      }),
  );

  // Opaque source dependency tokens are real pinned metadata. They exercise
  // cache admission without enlarging the selected source history or clipping it.
  const originalPin = intakeSourceVersion(db, source.id).sourcePin;
  const pin = (length: number, version: number) =>
    transaction(db, () => {
      writeIntakeSourcePin(db, source.id, {
        revisionId: originalPin?.revisionId ?? null,
        dependencyToken: 'fictional-token:'.padEnd(length, 'x'),
        requiresInterpretation: originalPin?.requiresInterpretation ?? false,
        version: (originalPin?.version ?? 0) + version,
      });
    });
  pin(40_000, 1);
  const charge = readRetainedPlanScope(db, profileId, source.id)!.retainedMetadataBytes();
  assert.ok(charge > 128 * 1024 && charge < 256 * 1024);
  read(units[0]);
  assert.ok(measured(units[0]).reads < first.reads);
  read(units[1]);
  assert.ok(
    measured(units[0]).reads > warm.reads,
    'aggregate bytes evict before the two-entry limit',
  );
  pin(80_000, 2);
  assert.ok(readRetainedPlanScope(db, profileId, source.id)!.retainedMetadataBytes() > 256 * 1024);
  const oversizedFirst = measured(units[0]),
    oversizedAgain = measured(units[0]);
  assert.deepEqual(oversizedAgain.scope, oversizedFirst.scope);
  assert.ok(
    oversizedFirst.reads > warm.reads && oversizedAgain.reads > warm.reads,
    'oversized context retains the complete cold behavior without cache admission',
  );
  t.diagnostic(JSON.stringify({ cold: first.reads, warm: warm.reads, aggregateCharge: charge }));
});

test('retained scope reuse rejects peer corruption, rollback repair and unavailable physical authority', async (t) => {
  const { db, root, profileId, source, units, read, measured } = await fixture(t);
  const first = read(units[0])!;
  const scope = readRetainedPlanScope(db, profileId, source.id)!,
    unit = scope.unitById(units[0]!)!;
  const { identity, collections } = selectedEnvelopeStore(db, { id: source.id }),
    view = collections.openView();
  const target = JSON.parse(
    String(
      collections.get(
        view,
        'logical',
        'envelope.data',
        'f:' + scope.reader.address(unit.record) + ':' + schemaKey('kind'),
      ),
    ),
  );
  assert.equal(target.type, 'cell');
  let key = '';
  const tree = createIntakeTree(
    identity,
    (hash) => {
      const rowKey = intakeNamespace(identity) + 'node:' + hash,
        raw = db.prepare('SELECT value FROM app_meta WHERE key=?').get(rowKey)?.value;
      if (typeof raw === 'string' && JSON.parse(raw).key === 'c:' + target.id) key = rowKey;
      return raw;
    },
    new Map(),
  );
  assert.ok(
    tree.get(collections.collection(view, 'logical', 'envelope.data')!.root, 'c:' + target.id),
  );
  assert.ok(key);
  const original = String(db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)!.value),
    change = db.prepare('UPDATE app_meta SET value=? WHERE key=?');
  const peer = new DatabaseSync(String(db.prepare('PRAGMA database_list').get()!.file));
  try {
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', key);
    assert.throws(() => read(units[0]), /schema|tree|collection/);
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(original, key);
  } finally {
    peer.close();
  }
  assert.deepEqual(read(units[0]), first);
  change.run('{}', key);
  assert.throws(() => read(units[0]), /schema|tree|collection/);
  db.exec('SAVEPOINT fictional_scope_repair');
  try {
    change.run(original, key);
    assert.deepEqual(read(units[0]), first);
    const changes = db.prepare('SELECT total_changes() AS n').get()!.n;
    db.exec('ROLLBACK TO fictional_scope_repair; RELEASE fictional_scope_repair');
    assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, changes);
    assert.throws(() => read(units[0]), /schema|tree|collection/);
  } finally {
    if (db.isTransaction)
      db.exec('ROLLBACK TO fictional_scope_repair; RELEASE fictional_scope_repair');
    change.run(original, key);
  }
  assert.deepEqual(read(units[0]), first);
  const warm = measured(units[0]).reads;
  clearIntakeStateCache(db);
  assert.ok(measured(units[0]).reads > warm);
  db.exec('CREATE TEMP TABLE fictional_scope_schema(value TEXT)');
  assert.ok(measured(units[0]).reads > warm);
  db.exec('DROP TABLE fictional_scope_schema');
  assert.throws(
    () =>
      openCollectionConversion(db, root, 'fictional-other', source.id, {
        sessionId: 'fictional-session',
        unitId: units[0],
      }),
    /profile|owner/i,
  );
  for (const kind of ['owner', 'source'] as const) {
    db.exec('SAVEPOINT fictional_scope_identity');
    try {
      if (kind === 'owner') change.run('fictional-other', 'owner_profile_id');
      else db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('0'.repeat(64), source.id);
      assert.throws(() => read(units[0]), /profile|owner|source|collection|envelope|head/i);
    } finally {
      db.exec('ROLLBACK TO fictional_scope_identity; RELEASE fictional_scope_identity');
    }
    assert.deepEqual(read(units[0]), first);
  }
  const head = join(contributorAuthorityPath(root, profileId), 'head'),
    saved = readFileSync(head);
  try {
    writeFileSync(head, '{}');
    assert.throws(() => read(units[0]), /record|head|authority|format|invalid/i);
  } finally {
    writeFileSync(head, saved);
  }
  assert.deepEqual(read(units[0]), first);
  db.close();
  assert.throws(() => read(units[0]), /closed|open/i);
});
