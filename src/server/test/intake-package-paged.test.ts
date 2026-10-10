import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../database.ts';
import { ensureProfileDirectories } from '../profile-storage.ts';
import { attachPersonalDurability } from '../portable.ts';
import { uploadIntake } from '../intake.ts';
import { openIntakeCollectionEnvelope } from '../intake-collection-envelope.ts';
import {
  inventoryIntakePackagePaged,
  readIntakePackageMemberPaged,
  validatePackageRolePlanPaged,
  readIntakePackageMetadataFragment,
} from '../intake-package.ts';
import { readDurablePackageInventory } from '../intake-package-state.ts';
import { intakeSourceVersion } from '../intake-state-access.ts';
import {
  recordIntakePackageFailurePaged,
  resolveIntakePackageFailurePaged,
} from '../intake-package-failures.ts';
import { intakeWorkCounters } from '../intake-work-accounting.ts';
import { clearPackageSourceSession, packageSourceSessionWork } from '../intake-package-session.ts';
import { zipFixture, type ZipFixtureEntry } from '../../tests/fixtures/zip.ts';
import { fictionalModel } from './fictional-model.ts';
import { DatabaseSync } from 'node:sqlite';
import { createIntakeFileWorkCounters, withIntakeFileWork } from '../intake-file-work.ts';
function fixture(t: test.TestContext, entries: ZipFixtureEntry[]) {
  fictionalModel(t);
  const root = mkdtempSync(join(tmpdir(), 'fictional-native-package-'));
  const profileId = 'cookie-dough',
    db = openDatabase(ensureProfileDirectories(root, profileId).database, profileId);
  attachPersonalDurability(db, { root, profileId });
  const intake = uploadIntake(db, root, profileId, {
    filename: 'fictional.zip',
    newProviderName: 'Fictional clinic',
    bytes: zipFixture(entries),
  });
  t.after(() => {
    clearPackageSourceSession(db);
    if (db.isOpen) db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, root, profileId, id: intake.id };
}

for (const count of [4, 32])
  test(`public member publications do not rescan a ${count}-member inventory`, async (t) => {
    const entries = Array.from({ length: count }, (_, ordinal) => ({
      name: `fictional-${ordinal}.txt`,
      data: `Fictional retained member ${ordinal}`,
    }));
    const f = fixture(t, entries);
    const inventoryWork = createIntakeFileWorkCounters();
    const page = await withIntakeFileWork(inventoryWork, () =>
      inventoryIntakePackagePaged({ ...f, limit: count }),
    );
    assert.equal(page.totalMembers, count);
    assert.equal(inventoryWork.packageWorkerAttempts, 1);
    assert.equal(inventoryWork.packageWorkerIncomplete, 0);
    assert.equal(inventoryWork.packageWorkerCentralDeclarations, count);
    assert.equal(inventoryWork.packageWorkerDescriptorReads, count);
    assert.equal(inventoryWork.packageWorkerMembersVerified, count);
    assert.equal(
      inventoryWork.packageWorkerMemberReadBytes,
      entries.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.data), 0),
    );
    const publicationWork = createIntakeFileWorkCounters();
    const selected = [0, count - 1];
    const children: string[] = [];
    await withIntakeFileWork(publicationWork, async () => {
      for (const ordinal of selected) {
        const result = await readIntakePackageMemberPaged({
          ...f,
          memberId: page.members[ordinal]!.memberId,
        });
        assert.ok('sourceFileId' in result && typeof result.sourceFileId === 'string');
        children.push(result.sourceFileId);
      }
    });
    assert.notEqual(children[0], children[1]);
    assert.equal(publicationWork.packageWorkerAttempts, selected.length);
    assert.equal(publicationWork.packageWorkerIncomplete, 0);
    assert.equal(publicationWork.packageWorkerCentralDeclarations, 0);
    assert.equal(publicationWork.packageWorkerDescriptorReads, selected.length);
    assert.equal(publicationWork.packageWorkerMembersVerified, selected.length);
    const selectedBytes = selected.reduce(
      (bytes, ordinal) => bytes + Buffer.byteLength(entries[ordinal]!.data),
      0,
    );
    assert.equal(publicationWork.packageWorkerMemberReadBytes, selectedBytes);
    assert.equal(publicationWork.packageWorkerHashBytes, selectedBytes);
    assert.equal(publicationWork.packageWorkerCrcBytes, selectedBytes);
    assert.equal(publicationWork.packageWorkerWrittenBytes, selectedBytes);
    assert.ok(publicationWork.packageWorkerPeakChunkBytes <= 256 * 1024);
    const retryWork = createIntakeFileWorkCounters();
    await withIntakeFileWork(retryWork, async () => {
      for (const [index, ordinal] of selected.entries()) {
        const result = await readIntakePackageMemberPaged({
          ...f,
          memberId: page.members[ordinal]!.memberId,
        });
        assert.ok('sourceFileId' in result);
        assert.equal(result.sourceFileId, children[index]);
      }
    });
    assert.equal(retryWork.packageWorkerAttempts, 0);
    assert.equal(retryWork.packageWorkerCentralDeclarations, 0);
    assert.equal(retryWork.packageWorkerDescriptorReads, 0);
  });

test('safe disposable spool refusal leaves a located inventory failure and only successful retry resolves it', async (t) => {
  const f = fixture(t, [{ name: 'fictional.txt', data: 'fictional' }]);
  const originalExec = DatabaseSync.prototype.exec;
  const mock = t.mock.method(
    DatabaseSync.prototype,
    'exec',
    function (this: DatabaseSync, sql: string) {
      if (sql.includes('CREATE TABLE central'))
        throw Object.assign(new Error('fictional spool refusal'), { errcode: 13 });
      return originalExec.call(this, sql);
    },
  );
  await assert.rejects(inventoryIntakePackagePaged(f), {
    status: 507,
    code: 'PACKAGE_STORAGE_FULL',
  });
  mock.mock.restore();
  const failureCount = () => {
    const source = f.db
      .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
      .get(f.id)!;
    const view = openIntakeCollectionEnvelope(
      f.db,
      source as unknown as Parameters<typeof openIntakeCollectionEnvelope>[1],
    );
    const dictionary = view.child(view.child(view.root(), 'intake')!, 'packageFailures')!;
    const first = view.fields(dictionary, { items: 1, bytes: 8192 }).fields[0];
    if (first) {
      const failure = view.child(dictionary, first.name)!;
      assert.deepEqual(view.field(failure, 'scope'), { kind: 'value', value: 'incomplete' });
      assert.deepEqual(view.field(failure, 'operationKey'), { kind: 'value', value: 'inventory' });
      assert.deepEqual(view.field(failure, 'originalFilename'), {
        kind: 'value',
        value: 'fictional.zip',
      });
      assert.deepEqual(view.field(failure, 'reasonCode'), {
        kind: 'value',
        value: 'PACKAGE_STORAGE_FULL',
      });
    }
    return view.info(dictionary).count;
  };
  assert.equal(failureCount(), 1);
  await resolveIntakePackageFailurePaged(f.db, f.root, f.profileId, f.id, {
    operationKey: 'extract:other',
  });
  assert.equal(failureCount(), 1);
  assert.equal((await inventoryIntakePackagePaged(f)).totalMembers, 1);
  assert.equal(failureCount(), 0);
});

test('native public pages and selected reads use durable independent occurrences and bounded role references', async (t) => {
  const f = fixture(t, [
    { name: 'reports/index.html', data: '<p>Fictional</p>' },
    { name: 'asset.txt', data: 'fictional asset' },
    { name: 'reports/asset.txt', data: 'fictional asset' },
    { name: 'one.txt', data: 'fictional retained bytes' },
  ]);
  const page = await inventoryIntakePackagePaged({ ...f, limit: 2 });
  assert.equal(page.format, 'health-intake-package-inventory-v2');
  assert.equal(page.totalMembers, 4);
  assert.equal(page.nextOffset, 2);
  const before = intakeWorkCounters(f.db);
  const cold = packageSourceSessionWork(f.db)!.coldHashBytes;
  const second = await inventoryIntakePackagePaged({ ...f, offset: 2, limit: 2 });
  assert.equal(second.nextOffset, null);
  assert.equal(packageSourceSessionWork(f.db)!.coldHashBytes, cold);
  const after = intakeWorkCounters(f.db);
  assert.equal(after.warm.sourceDTOHydrations - before.warm.sourceDTOHydrations, 0);
  assert.equal(after.warm.envelopeHydrations - before.warm.envelopeHydrations, 0);
  const inventory = readDurablePackageInventory({
    ...f,
    rawDomainVersion: intakeSourceVersion(f.db, f.id).rawVersion,
  })!;
  const roles = validatePackageRolePlanPaged(inventory, {
    roles: [
      {
        memberId: inventory.member(0)!.memberId,
        role: 'context',
        reason: 'Fictional HTML',
        coverage: 'pending',
        references: [
          { path: 'asset.txt', reason: 'Fictional literal relative reference' },
          { path: '/host/path', reason: 'Unsafe fixture' },
        ],
      },
    ],
  });
  assert.equal(roles[0].references[0].status, 'ambiguous');
  assert.deepEqual(
    new Set(roles[0].references[0].candidateMemberIds),
    new Set([inventory.member(1)!.memberId, inventory.member(2)!.memberId]),
  );
  assert.equal(roles[0].references[1].status, 'not_supplied');
  const member = inventory.member(3)!;
  const read = await readIntakePackageMemberPaged({ ...f, memberId: member.memberId });
  assert.ok('sourceFileId' in read && read.sourceFileId);
  const beforeRetry = intakeWorkCounters(f.db);
  const retry = await readIntakePackageMemberPaged({ ...f, memberId: member.memberId });
  assert.ok('sourceFileId' in retry);
  assert.equal(retry.sourceFileId, read.sourceFileId);
  const afterRetry = intakeWorkCounters(f.db);
  assert.equal(afterRetry.warm.sourceDTOHydrations - beforeRetry.warm.sourceDTOHydrations, 0);
  assert.equal(afterRetry.warm.envelopeHydrations - beforeRetry.warm.envelopeHydrations, 0);
  assert.equal(
    packageSourceSessionWork(f.db)!.coldHashBytes,
    cold + Buffer.byteLength('fictional retained bytes'),
  );
});

test('oversized exact names use pinned references and UTF8-safe bounded metadata fragments', async (t) => {
  const filename = 'fictional-' + '🦄"'.repeat(10000) + '.txt';
  const f = fixture(t, [{ name: filename, data: 'fictional' }]);
  const page = await inventoryIntakePackagePaged(f);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 40000);
  const entry = page.members[0];
  assert.ok('format' in entry && entry.format === 'health-intake-package-member-reference-v1');
  assert.equal(entry.filenameTruncated, true);
  const fragments: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const result = await readIntakePackageMetadataFragment(
      { ...f, offset, limit: 4097 },
      entry.metadata,
    );
    assert.ok(Buffer.byteLength(result.text) <= 4097);
    assert.ok(!result.text.includes('�'));
    fragments.push(result.text);
    offset = result.nextOffset;
  }
  const exact = JSON.parse(fragments.join(''));
  assert.equal(exact.filename, filename);
  assert.equal(exact.locator, 'ZIP member ' + filename);
  const read = await readIntakePackageMemberPaged({ ...f, memberId: entry.memberId });
  assert.ok(
    'member' in read &&
      read.member &&
      'format' in read.member &&
      read.member.format === 'health-intake-package-member-reference-v1',
  );
  assert.ok(Buffer.byteLength(JSON.stringify(read)) < 40000);
  assert.ok('original' in read && read.original && 'intake' in read.original);
  assert.equal(
    (read.original.intake as { format: string }).format,
    'health-intake-package-original-identity-v2',
  );
  await assert.rejects(
    readIntakePackageMetadataFragment(f, { ...entry.metadata, metadataHash: '0'.repeat(64) }),
    { code: 'PACKAGE_METADATA_CHANGED' },
  );
  await assert.rejects(
    readIntakePackageMetadataFragment(f, { ...entry.metadata, inventoryId: '0'.repeat(64) }),
    { code: 'PACKAGE_METADATA_CHANGED' },
  );
});

test('native located failures preserve exact large scope, no-op replay and point-only resolution', async (t) => {
  const f = fixture(t, [{ name: 'fictional.txt', data: 'fictional' }]);
  const filename = 'fictional/' + 'x'.repeat(10000) + '.txt';
  const input = {
    operationKey: 'extract:member:fictional',
    memberId: 'member:fictional',
    ordinal: 3,
    filename,
    locator: 'ZIP member ' + filename,
    reasonCode: 'PACKAGE_STORAGE',
    detail: 'Fictional write refusal',
  };
  const first = await recordIntakePackageFailurePaged(f.db, f.root, f.profileId, f.id, input);
  assert.equal(first.changed, true);
  const before = intakeWorkCounters(f.db);
  const replay = await recordIntakePackageFailurePaged(f.db, f.root, f.profileId, f.id, input);
  assert.equal(replay.changed, false);
  assert.equal(replay.version, first.version);
  const wrong = await resolveIntakePackageFailurePaged(f.db, f.root, f.profileId, f.id, {
    operationKey: 'inventory',
  });
  assert.equal(wrong.changed, false);
  const resolved = await resolveIntakePackageFailurePaged(f.db, f.root, f.profileId, f.id, {
    operationKey: input.operationKey,
  });
  assert.equal(resolved.changed, true);
  const again = await resolveIntakePackageFailurePaged(f.db, f.root, f.profileId, f.id, {
    operationKey: input.operationKey,
  });
  assert.equal(again.changed, false);
  const after = intakeWorkCounters(f.db);
  assert.equal(after.warm.sourceDTOHydrations - before.warm.sourceDTOHydrations, 0);
  assert.equal(after.warm.envelopeHydrations - before.warm.envelopeHydrations, 0);
  const source = f.db
    .prepare('SELECT id,kind,sha256,details_json FROM source_files WHERE id=?')
    .get(f.id)!;
  const view = openIntakeCollectionEnvelope(
    f.db,
    source as unknown as Parameters<typeof openIntakeCollectionEnvelope>[1],
  );
  const dictionary = view.child(view.child(view.root(), 'intake')!, 'packageFailures')!;
  assert.equal(view.info(dictionary).count, 0);
});
