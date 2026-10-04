import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, transaction, clinicalReviewRevision, type Database } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import {
  attachRecordDurability,
  rebuildRecordDatabase,
  type RecordStorage,
} from '../record-versions.ts';
import { createIntakeStateStorage, clearIntakeStateCache } from '../intake-state-storage.ts';
import { clearPackageSourceSession, packageSourceSessionWork } from '../intake-package-session.ts';
import {
  buildDurablePackageInventory,
  readDurablePackageInventory,
  rebindCopiedPackageInventory,
} from '../intake-package-state.ts';
import { zipFixture, type ZipFixtureEntry } from '../../tests/fixtures/zip.ts';
import { packageMemberUnit } from '../intake-plan.ts';
import { workflowHash } from '../intake-workflow.ts';
import {
  prepareInitialIntakeEnvelope,
  readIntakeEnvelopeMaterialized,
} from '../intake-authority.ts';
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function fixture(t: test.TestContext, entries: ZipFixtureEntry[], legacy = false) {
  const root = mkdtempSync(join(tmpdir(), 'fictional-package-authority-'));
  const profileId = 'cookie-dough',
    paths = ensureProfileDirectories(root, profileId);
  const bytes = zipFixture(entries),
    id = 'fictional-package';
  const relative = paths.relativeRoot + '/sources/fictional.zip';
  writeFileSync(join(root, relative), bytes);
  const db = openDatabase(paths.database, profileId);
  db.prepare(
    'INSERT INTO source_files(id,path,sha256,bytes,kind,details_json) VALUES(?,?,?,?,?,?)',
  ).run(id, relative, hash(bytes), bytes.length, 'intake_original', '{}');
  const objects = new Map<string, Buffer>();
  const storage: RecordStorage = {
    read: (key) => objects.get(key) ?? null,
    writeImmutable: (key, value) => {
      assert.ok(!objects.has(key));
      objects.set(key, Buffer.from(value));
    },
    publishHead: (value) => {
      objects.set('head', Buffer.from(value));
    },
  };
  attachRecordDurability(db, { profileId, storage });
  const identity = { profileId, intakeId: id, sourceHash: hash(bytes) };
  const full = createIntakeStateStorage(db, identity);
  const store = full.collections;
  const operationId = randomUUID();
  if (legacy) {
    const initial = prepareInitialIntakeEnvelope({
      untouched: 'fictional retained',
      intake: {
        version: 7,
        originalName: 'fictional.zip',
        workflow: { format: 'health-intake-workflow-v1', candidates: [] },
      },
    });
    transaction(db, () => {
      db.prepare('UPDATE source_files SET details_json=? WHERE id=?').run(initial.detailsJson, id);
      full.stage(initial.state, operationId);
    });
  } else {
    const prepared = store.prepare(store.openView(), {
      operationId,
      requestDigest: hash(operationId),
      domainVersion: 7,
      changes: [
        { area: 'logical', collection: 'facts', op: 'put', key: 'review', value: 'pending' },
      ],
    });
    transaction(db, () => store.stage(prepared));
  }
  const databases: Database[] = [db];
  t.after(() => {
    for (const item of databases) {
      clearPackageSourceSession(item);
      clearIntakeStateCache(item);
      if (item.isOpen) item.close();
    }
    rmSync(root, { recursive: true, force: true });
  });
  const context = { db, root, profileId, id, rawDomainVersion: 7 };
  return {
    context,
    store,
    bytes,
    objects,
    rebuild() {
      clearPackageSourceSession(db);
      clearIntakeStateCache(db);
      db.close();
      const path = join(paths.databaseDirectory, 'rebuilt.sqlite');
      rebuildRecordDatabase(path, { profileId, storage });
      const next = openDatabase(path, profileId);
      attachRecordDurability(next, { profileId, storage });
      databases.push(next);
      return { ...context, db: next };
    },
  };
}

test('complete inventory persists exact occurrences without changing logical review and reuses after cache loss/rebuild', async (t) => {
  const f = fixture(t, [
    { name: 'one.json', data: '{"fictional":"1.000"}' },
    { name: 'copy.json', data: '{"fictional":"1.000"}' },
    { name: 'last.txt', data: 'different' },
  ]);
  const revision = clinicalReviewRevision(f.context.db);
  const logical = f.store.binding(f.store.openView())!.logical;
  assert.equal(readDurablePackageInventory(f.context), undefined);
  const result = await buildDurablePackageInventory(f.context);
  assert.equal(result.inventory.summary.members, 3);
  assert.equal(result.sourceVerificationWork.coldHashBytes, f.bytes.length);
  assert.equal(result.sourceVerificationWork.coldReadBytes, f.bytes.length);
  assert.ok(result.spoolWork!.metadataWrittenBytes > 0);
  assert.ok(result.work.peakCheckpointEdits! <= 64);
  assert.ok(result.work.peakCheckpointEncodedBytes! <= 32768);
  assert.equal(result.inventory.uniqueByteContents, 2);
  assert.ok(result.work.checkpoints < 5);
  const members = [...result.inventory.range()];
  assert.equal(members[0].memberId, 'member:' + workflowHash([f.context.id, 0, 'one.json']));
  assert.equal(members[1].duplicateOf, members[0].memberId);
  assert.notEqual(members[0].memberId, members[1].memberId);
  assert.deepEqual(result.inventory.byId(members[2].memberId), members[2]);
  assert.deepEqual(result.inventory.byUnit(packageMemberUnit(members[2]).id), members[2]);
  assert.deepEqual(result.inventory.byExactName('copy.json'), members[1]);
  assert.equal(result.inventory.byExactName('absent'), undefined);
  assert.equal(clinicalReviewRevision(f.context.db), revision);
  assert.deepEqual(f.store.binding(f.store.openView())!.logical, logical);
  const beforeObjects = f.objects.size;
  const retry = await buildDurablePackageInventory(f.context);
  assert.equal(retry.reused, true);
  assert.equal(retry.work.checkpoints, 0);
  assert.equal(f.objects.size, beforeObjects);
  const cold = packageSourceSessionWork(f.context.db)!.coldHashBytes;
  assert.equal(cold, f.bytes.length);
  const context = f.rebuild();
  const recovered = readDurablePackageInventory(context)!;
  assert.equal(recovered.inventoryId, result.inventory.inventoryId);
  assert.deepEqual([...recovered.range()], members);
  const replay = await buildDurablePackageInventory(context);
  assert.equal(replay.reused, true);
  assert.equal(f.objects.size, beforeObjects);
  assert.equal(packageSourceSessionWork(context.db), null);
  assert.deepEqual(readdirSync(join(context.root, '.package-index-staging')), []);
});

test('copy requalification preserves public inventory identity and refuses stale source root pins', async (t) => {
  const f = fixture(t, [{ name: 'fictional.txt', data: 'fictional' }]);
  const result = await buildDurablePackageInventory(f.context);
  const binding = result.inventory.binding;
  const text = f.store.get(f.store.openView(), 'builds', 'package.inventories', binding.sourceHash);
  assert.equal(typeof text, 'string');
  const sourceCollection = (name: string) =>
    f.store.collection(f.store.openView(), 'builds', name) ?? null;
  const transform = {
    text: text as string,
    key: binding.sourceHash,
    sourceBinding: binding,
    targetProfileId: 'fictional-target',
    sourceCollection,
    rebindDescriptor: (descriptor: NonNullable<ReturnType<typeof sourceCollection>>) => ({
      ...descriptor,
      root: descriptor.root && { ...descriptor.root, hash: 'c'.repeat(64) },
    }),
  };
  const copied = JSON.parse(rebindCopiedPackageInventory(transform));
  assert.equal(copied.inventoryId, result.inventory.inventoryId);
  assert.equal(copied.binding.profileId, 'fictional-target');
  assert.equal(copied.binding.sourceHash, binding.sourceHash);
  assert.equal(copied.roots.records.root.hash, 'c'.repeat(64));
  assert.throws(
    () => rebindCopiedPackageInventory({ ...transform, sourceCollection: () => null }),
    /pin changed/,
  );
  assert.throws(
    () =>
      rebindCopiedPackageInventory({
        ...transform,
        sourceBinding: { ...binding, bytes: binding.bytes + 1 },
      }),
    /binding is invalid/,
  );
});

test('legacy v3 bridge preserves original envelope and review before publishing independent complete inventory', async (t) => {
  const f = fixture(t, [{ name: 'fictional.txt', data: 'fictional' }], true);
  const source = { id: f.context.id, kind: 'intake_original', sha256: hash(f.bytes) };
  const before = readIntakeEnvelopeMaterialized(f.context.db, source).text;
  const revision = clinicalReviewRevision(f.context.db);
  assert.equal(readDurablePackageInventory(f.context), undefined);
  const result = await buildDurablePackageInventory(f.context);
  assert.equal(result.inventory.summary.members, 1);
  assert.equal(readIntakeEnvelopeMaterialized(f.context.db, source).text, before);
  assert.equal(clinicalReviewRevision(f.context.db), revision);
  assert.equal(f.store.binding(f.store.openView())!.logical.domainVersion, 7);
});

test('unrelated auxiliary checkpoints preserve inventory but mutations of pinned collections revoke checked members', async (t) => {
  const f = fixture(t, [{ name: 'fictional.txt', data: 'fictional' }]);
  const result = await buildDurablePackageInventory(f.context);
  const member = result.inventory.member(0)!;
  const checkpoint = (collection: string, key: string, value: string) => {
    const operationId = randomUUID();
    f.store.commitMaintenance(
      f.store.prepare(f.store.openView(), {
        operationId,
        requestDigest: hash(operationId),
        domainVersion: 7,
        changes: [{ area: 'builds', collection, op: 'put', key, value }],
      }),
    );
  };
  checkpoint('fictional.other', 'unrelated', 'retained');
  assert.deepEqual(result.inventory.member(0), member);
  result.inventory.checkedMember(0);
  checkpoint('pkg.' + result.inventory.inventoryId + '.byId', member.memberId, '1');
  assert.throws(() => result.inventory.checkedMember(0), /collection changed/);
  assert.throws(() => readDurablePackageInventory(f.context), /collection changed/);
});

test('late CRC failure leaves only incomplete retained scope through disposable cache loss and replay', async (t) => {
  const f = fixture(t, [
    ...Array.from({ length: 15 }, (_, ordinal) => ({
      name: `fictional-${ordinal}.txt`,
      data: 'fictional',
    })),
    { name: 'corrupt.txt', data: 'fictional corrupted', checksum: 0 },
  ]);
  await assert.rejects(buildDurablePackageInventory(f.context), { reasonCode: 'PACKAGE_CHECKSUM' });
  assert.equal(readDurablePackageInventory(f.context), undefined);
  const context = f.rebuild();
  assert.equal(readDurablePackageInventory(context), undefined);
  await assert.rejects(buildDurablePackageInventory(context), { reasonCode: 'PACKAGE_CHECKSUM' });
  assert.equal(readDurablePackageInventory(context), undefined);
  assert.deepEqual(readdirSync(join(context.root, '.package-index-staging')), []);
});

test('interrupted attempt retains completed prefix and retries exact scope without rewriting it', async (t) => {
  const f = fixture(
    t,
    Array.from({ length: 30 }, (_, ordinal) => ({
      name: `fictional-${ordinal}.txt`,
      data: 'same bytes',
    })),
  );
  let cancel = false,
    observed = 0;
  const context = {
    ...f.context,
    assertRunning() {
      if (cancel) throw Error('fictional cancelled');
    },
  };
  await assert.rejects(
    buildDurablePackageInventory(context, {
      onProgress(work) {
        if (work.verifiedRecords >= 5) {
          observed = work.verifiedRecords;
          cancel = true;
        }
      },
    }),
    /fictional cancelled/,
  );
  assert.ok(observed >= 5);
  assert.equal(readDurablePackageInventory(f.context), undefined);
  const recoveredContext = f.rebuild();
  const retry = await buildDurablePackageInventory(recoveredContext);
  assert.ok(retry.work.retainedRecords > 0);
  assert.equal(retry.work.reusedRecords, retry.work.retainedRecords);
  assert.equal(retry.work.verifiedRecords + retry.work.reusedRecords, 30);
  assert.equal(retry.traversalWork!.membersReused, retry.work.retainedRecords);
  assert.equal(retry.traversalWork!.membersVerified, 30 - retry.work.retainedRecords);
  assert.equal(retry.traversalWork!.descriptorReads, 30 - retry.work.retainedRecords);
  assert.equal(retry.traversalWork!.centralDeclarations, 30);
  assert.equal(retry.traversalWork!.hashBytes, (30 - retry.work.retainedRecords) * 10);
  assert.equal(retry.traversalWork!.crcBytes, retry.traversalWork!.hashBytes);
  assert.equal(retry.traversalWork!.reusedPayloadBytes, retry.work.retainedRecords * 10);
  assert.equal(retry.sourceVerificationWork.coldHashBytes, f.bytes.length);
  assert.ok(retry.work.prefixDescriptorReadBytes > 0);
  assert.equal(retry.work.prefixDescriptorHashBytes, retry.work.prefixDescriptorReadBytes);
  assert.equal([...retry.inventory.range({ limit: 30 })].length, 30);
  assert.equal(retry.inventory.uniqueByteContents, 1);
});

test('large legal name checkpoints partial bytes and resumes without repeated retained chunk writes', async (t) => {
  const filename = 'fictional-' + '"'.repeat(50000) + '.txt';
  const f = fixture(t, [{ name: filename, data: 'fictional' }]);
  let cancel = false;
  await assert.rejects(
    buildDurablePackageInventory(
      {
        ...f.context,
        assertRunning() {
          if (cancel) throw Error('fictional interrupted');
        },
      },
      {
        onProgress(work) {
          if (work.checkpoints >= 2) cancel = true;
        },
      },
    ),
    /fictional interrupted/,
  );
  assert.equal(readDurablePackageInventory(f.context), undefined);
  const result = await buildDurablePackageInventory(f.context);
  assert.equal(result.traversalWork!.membersReused, 0);
  assert.equal(result.traversalWork!.membersVerified, 1);
  assert.equal(result.traversalWork!.hashBytes, Buffer.byteLength('fictional'));
  assert.equal(result.inventory.member(0)!.filename, filename);
  assert.deepEqual(result.inventory.byExactName(filename), result.inventory.member(0));
  assert.equal(result.inventory.summary.members, 1);
  const rebuild = f.rebuild();
  assert.equal(readDurablePackageInventory(rebuild)!.member(0)!.filename, filename);
});

test('authenticated but inconsistent retained prefix refuses reuse without publishing complete inventory', async (t) => {
  const f = fixture(t, [{ name: 'fictional.txt', data: 'fictional' }]);
  let cancelled = false;
  await assert.rejects(
    buildDurablePackageInventory(
      {
        ...f.context,
        assertRunning() {
          if (cancelled) throw Error('fictional interrupted');
        },
      },
      {
        onProgress(work) {
          if (work.verifiedRecords) cancelled = true;
        },
      },
    ),
    /fictional interrupted/,
  );
  const view = f.store.openView();
  const sourceHash = hash(f.bytes);
  const inventoryId = f.store.get(view, 'builds', 'package.attempts', sourceHash) as string;
  const collection = `pkg.${inventoryId}.records`,
    key = '0000000000000000';
  const retained = JSON.parse(f.store.get(view, 'builds', collection, key) as string);
  const operationId = randomUUID();
  f.store.commitMaintenance(
    f.store.prepare(view, {
      operationId,
      requestDigest: hash(operationId),
      domainVersion: 7,
      changes: [
        {
          area: 'builds',
          collection,
          op: 'put',
          key,
          value: JSON.stringify({ ...retained, sourceHash: '0'.repeat(64) }),
        },
      ],
    }),
  );
  await assert.rejects(buildDurablePackageInventory(f.context), {
    reasonCode: 'PACKAGE_PREFIX_CHANGED',
    filename: 'fictional.txt',
    ordinal: 0,
  });
  assert.equal(readDurablePackageInventory(f.context), undefined);
});
