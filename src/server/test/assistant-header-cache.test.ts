import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { attachPersonalDurability } from '../portable.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { contributorAuthorityPath } from '../contributor-record-storage.ts';
import { uploadIntake, createIntakePlan, updateIntakeMetadataRead } from '../intake.ts';
import { buildIntakeCollectionEnvelope } from '../intake-envelope-build.ts';
import { prepareRetainedPlanAccess, readRetainedPlanScope } from '../intake-retained-plan.ts';
import { selectedEnvelopeStore } from '../intake-collection-envelope.ts';
import { schemaKey } from '../intake-envelope-schema.ts';
import { intakeNamespace } from '../intake-state-evidence.ts';
import { createIntakeTree } from '../intake-state-tree.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import { writeIntakeSourcePin } from '../intake-source-pin.ts';
import { clearIntakeStateCache } from '../intake-state-storage.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { readNativeAssistantSourceHeader } from '../assistant-intake-header.ts';
import { fictionalModel } from './fictional-model.ts';
import { prepareCollectionWorkflowReadiness } from '../intake-workflow-readiness.ts';
import { workflowHash } from '../intake-workflow.ts';
import { activeMappingRules } from '../clinical-import.ts';

test('assistant header reuse rejects changed, rolled-back and physically unavailable authority', async (t) => {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-assistant-header-cache-')),
    profileId = 'fictional-header-cache',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  t.after(() => {
    clearIntakeStateCache(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const source = uploadIntake(db, root, profileId, {
    filename: 'fictional.txt',
    bytes: Buffer.from('Independently fictional cached source.'),
  });
  await createIntakePlan(db, root, profileId, source.id, { version: source.version });
  await buildIntakeCollectionEnvelope(db, { id: source.id });
  await prepareRetainedPlanAccess(db, profileId, source.id);
  await prepareCollectionWorkflowReadiness(db, root, profileId, source.id, {
    mappingVersion: workflowHash(activeMappingRules(db, source.providerId)),
  });
  const read = () => readNativeAssistantSourceHeader(db, root, profileId, source.id)!;
  clearIntakeStateCache(db);
  const before = intakeWorkCounters(db).warm.collectionNodeReads;
  let first = read();
  const cold = intakeWorkCounters(db).warm.collectionNodeReads - before;
  read();
  const warmBefore = intakeWorkCounters(db).warm.collectionNodeReads;
  assert.deepEqual(read(), first);
  const warm = intakeWorkCounters(db).warm.collectionNodeReads - warmBefore;
  assert.ok(warm < cold, 'unchanged header facts avoid re-decoding selected plan fields');
  assert.equal(first.activePlan.state, 'exact');
  assert.ok(first.activePlan.plan);
  assert.throws(() => {
    first.activePlan.plan!.pins.sourceHash = 'fictional-poison';
  }, TypeError);
  assert.throws(() => {
    first.durability.pending = true;
  }, TypeError);
  clearIntakeStateCache(db);
  const clearedBefore = intakeWorkCounters(db).warm.collectionNodeReads;
  assert.deepEqual(read(), first);
  assert.ok(intakeWorkCounters(db).warm.collectionNodeReads - clearedBefore > warm);
  const updated = await updateIntakeMetadataRead(db, root, profileId, source.id, {
    version: first.version,
    operationId: 'fictional-header-update',
    metadata: { source: 'Fictional corrected clinic' },
  });
  assert.equal(read().version, updated.version);
  assert.notEqual(read().version, first.version);
  await prepareCollectionWorkflowReadiness(db, root, profileId, source.id, {
    mappingVersion: workflowHash(activeMappingRules(db, read().providerId)),
  });
  first = read();
  assert.equal(first.activePlan.state, 'exact');
  assert.ok(first.activePlan.plan);

  // Find an actual authenticated cell consumed by the cached retained-plan header.
  await prepareRetainedPlanAccess(db, profileId, source.id);
  const scope = readRetainedPlanScope(db, profileId, source.id)!;
  const { identity, collections } = selectedEnvelopeStore(db, { id: source.id }),
    view = collections.openView(),
    target = JSON.parse(
      String(
        collections.get(
          view,
          'logical',
          'envelope.data',
          'f:' + scope.reader.address(scope.record) + ':' + schemaKey('createdAt'),
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
      assert.equal(typeof raw, 'string');
      if (JSON.parse(String(raw)).key === 'c:' + target.id) key = rowKey;
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
  read();
  change.run('{}', key);
  assert.throws(read, /schema|tree|collection/);
  change.run(original, key);
  assert.deepEqual(read(), first);
  const peer = new DatabaseSync(String(db.prepare('PRAGMA database_list').get()!.file));
  try {
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run('{}', key);
    assert.throws(read, /schema|tree|collection/);
    peer.prepare('UPDATE app_meta SET value=? WHERE key=?').run(original, key);
    assert.deepEqual(read(), first);
  } finally {
    peer.close();
  }
  change.run('{}', key);
  db.exec('SAVEPOINT fictional_header_repair');
  try {
    change.run(original, key);
    assert.deepEqual(read(), first);
    const changes = db.prepare('SELECT total_changes() AS n').get()!.n;
    db.exec('ROLLBACK TO fictional_header_repair; RELEASE fictional_header_repair');
    assert.equal(db.prepare('SELECT total_changes() AS n').get()!.n, changes);
    assert.throws(
      read,
      /schema|tree|collection/,
      'temporary repair cannot survive rollback in cache',
    );
  } finally {
    if (db.isTransaction)
      db.exec('ROLLBACK TO fictional_header_repair; RELEASE fictional_header_repair');
    change.run(original, key);
  }
  assert.deepEqual(read(), first);
  const logical = intakeSourceVersion(db, source.id).logicalBinding;
  db.exec('SAVEPOINT fictional_header_pin');
  try {
    writeIntakeSourcePin(db, source.id, {
      revisionId: null,
      dependencyToken: 'fictional-material',
      requiresInterpretation: false,
      version: 1,
    });
    assert.equal(intakeSourceVersion(db, source.id).logicalBinding, logical);
    assert.equal(read().version, first.version + 1);
  } finally {
    db.exec('ROLLBACK TO fictional_header_pin; RELEASE fictional_header_pin');
  }
  assert.deepEqual(read(), first);
  for (const field of ['owner', 'source'] as const) {
    db.exec('SAVEPOINT fictional_header_identity');
    try {
      if (field === 'owner') change.run('fictional-other', 'owner_profile_id');
      else db.prepare('UPDATE source_files SET sha256=? WHERE id=?').run('0'.repeat(64), source.id);
      assert.throws(read, /profile|owner|source|collection|envelope|identity|head/i);
    } finally {
      db.exec('ROLLBACK TO fictional_header_identity; RELEASE fictional_header_identity');
    }
    assert.deepEqual(read(), first);
  }
  assert.throws(() => readNativeAssistantSourceHeader(db, root, 'fictional-other', source.id), {
    code: 'PROFILE_BOUNDARY',
  });
  const schemaBefore = intakeWorkCounters(db).warm.collectionNodeReads;
  db.exec('CREATE TEMP TABLE fictional_header_schema(value TEXT)');
  assert.deepEqual(read(), first);
  assert.ok(intakeWorkCounters(db).warm.collectionNodeReads - schemaBefore > warm);
  db.exec('DROP TABLE fictional_header_schema');
  read();
  // This mutation leaves every SQL stamp unchanged; the physical head must still be checked.
  const head = join(contributorAuthorityPath(root, profileId), 'head'),
    savedHead = readFileSync(head);
  try {
    writeFileSync(head, '{}');
    assert.throws(read, /record|head|authority|format|invalid/i);
  } finally {
    writeFileSync(head, savedHead);
  }
  assert.deepEqual(read(), first);
  t.diagnostic(JSON.stringify({ cold, warm }));
  db.close();
  assert.throws(read, /closed|open/i);
});
